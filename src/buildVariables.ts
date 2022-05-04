import isObject from 'lodash/isObject';
import getFinalType from './utils/getFinalType';
import { IntrospectionResult, Resource } from './constants/interfaces';
import {
  GET_LIST,
  GET_ONE,
  GET_MANY,
  GET_MANY_REFERENCE,
  CREATE,
  UPDATE,
  DELETE
} from 'ra-core/lib/core/dataFetchActions';
import {
  PRISMA_CONNECT,
  PRISMA_DISCONNECT,
  PRISMA_UPDATE,
  PRISMA_CREATE,
  PRISMA_DELETE,
  PRISMA_SET
} from './constants/mutations';
import {
  IntrospectionInputObjectType,
  IntrospectionObjectType,
  IntrospectionType,
  IntrospectionNamedTypeRef,
  IntrospectionInputValue
} from 'graphql';

interface GetListParams {
  filter: { [key: string]: any };
  pagination: { page: number; perPage: number };
  sort: { field: string; order: string };
}

//TODO: Object filter weren't tested yet
const buildGetListVariables = (introspectionResults: IntrospectionResult) => (
  resource: Resource,
  aorFetchType: string,
  params: GetListParams
) => {
  const filter = Object.keys(params.filter).reduce((acc, key) => {
    if (key === 'ids') {
      return { ...acc, id_in: params.filter[key] };
    }

    if (Array.isArray(params.filter[key])) {
      const type = introspectionResults.types.find(
        t => t.name === `${resource.type.name}WhereInput`
      ) as IntrospectionInputObjectType;
      const inputField = type.inputFields.find(t => t.name === key);

      if (!!inputField) {
        return {
          ...acc,
          [key]: params.filter[key]
        };
      }
    }

    if (isObject(params.filter[key])) {
      const type = introspectionResults.types.find(
        t => t.name === `${resource.type.name}WhereInput`
      ) as IntrospectionInputObjectType;
      const filterSome = type.inputFields.find(t => t.name === `${key}_some`);

      if (filterSome) {
        const filter = Object.keys(params.filter[key]).reduce(
          (acc, k: string) => ({
            ...acc,
            [`${k}_in`]: params.filter[key][k] as string[]
          }),
          {} as { [key: string]: string[] }
        );
        return { ...acc, [`${key}_some`]: filter };
      }
    }

    const parts = key.split('.');

    if (parts.length > 1) {
      if (parts[1] == 'id') {
        const type = introspectionResults.types.find(
          t => t.name === `${resource.type.name}WhereInput`
        ) as IntrospectionInputObjectType;
        const filterSome = type.inputFields.find(
          t => t.name === `${parts[0]}_some`
        );

        if (filterSome) {
          return {
            ...acc,
            [`${parts[0]}_some`]: { id: params.filter[key] }
          };
        }

        return { ...acc, [parts[0]]: { id: params.filter[key] } };
      }

      const resourceField = (resource.type as IntrospectionObjectType).fields.find(
        f => f.name === parts[0]
      )!;
      if ((resourceField.type as IntrospectionNamedTypeRef).name === 'Int') {
        return { ...acc, [key]: parseInt(params.filter[key]) };
      }
      if ((resourceField.type as IntrospectionNamedTypeRef).name === 'Float') {
        return { ...acc, [key]: parseFloat(params.filter[key]) };
      }
    }

    return { ...acc, [key]: params.filter[key] };
  }, {});

  return {
    skip: (params.pagination.page - 1) * params.pagination.perPage,
    first: params.pagination.perPage,
    orderBy: `${params.sort.field}_${params.sort.order}`,
    where: filter
  };
};

const findInputObjectType = (
  introspectionResults: IntrospectionResult,
  typeName: string,
  key?: string
) => {
  const type = introspectionResults.types.find(
    t => t.name === typeName
  ) as IntrospectionInputObjectType | undefined;

  if (!key || !type) {
    return type
  }

  return type.inputFields.find(t => t.name === key) as IntrospectionInputObjectType | undefined;
}

const findInputFieldForType = (
  introspectionResults: IntrospectionResult,
  typeName: string,
  field: string
) => {
  const type = findInputObjectType(introspectionResults, typeName)

  if (!type) {
    return null;
  }

  const inputFieldType = type.inputFields.find(t => t.name === field);

  if (!inputFieldType) {
    return null
  }

  return getFinalType(inputFieldType.type)
};

const findMutationInputType = (
  introspectionResults: IntrospectionResult,
  typeName: string,
  field: string,
  mutationType: string
) => {
  const inputType = findInputFieldForType(
    introspectionResults,
    typeName,
    field
  );

  return findInputFieldForType(
    introspectionResults,
    inputType!.name,
    mutationType
  );
};

const hasMutationInputType = (
  introspectionResults: IntrospectionResult,
  typeName: string,
  field: string,
  mutationType: string
) => {
  return Boolean(
    findMutationInputType(introspectionResults, typeName, field, mutationType)
  );
};

const buildReferenceField = ({
  inputArg,
  previousInputArg,
  introspectionResults,
  parentTypeName,
  typeName,
  field,
  mutationType
}: {
  inputArg: { [key: string]: any };
  previousInputArg: { [key: string]: any };
  introspectionResults: IntrospectionResult;
  parentTypeName: string;
  typeName: string;
  field: string;
  mutationType: string;
}) => {
  const mutationInputType = findMutationInputType(
    introspectionResults,
    parentTypeName,
    field,
    mutationType
  );

  const inputObjectType = findInputObjectType(introspectionResults, typeName, field) as IntrospectionInputObjectType

  if (mutationType === PRISMA_CONNECT) {
    const idOrIds = inputArg.id

    if (Array.isArray(idOrIds)) {
      return idOrIds.map(value => ({ id: value }))
    }

    return { id: idOrIds }
  }

  const currentInputField = findInputFieldForType(
    introspectionResults,
    typeName,
    mutationType
  )!;

  const { where, data } = Object.keys(inputArg).reduce((acc, key) => {
    return traverseVariables(
      introspectionResults,
      currentInputField.name,
      {
        data: inputArg,
        previousData: previousInputArg
      },
      key,
      acc
    )
  }, {}) as {
    where: Params;
    data: Params;
  };

  // Relation 'create' will not have 'data' child. Example: (owner-create)
  // createFile(data: {
  //   owner: {
  //     create: {
  //       id
  //     }
  //   }
  // })
  if (mutationType === PRISMA_CREATE) {
    return data
  }

  if (!findInputFieldForType(
    introspectionResults,
    currentInputField.name,
    "where"
  )) {
    return data
  }

  return { where, data }
};

const buildObjectMutationData = ({
  inputArg,
  previousInputArg,
  introspectionResults,
  parentTypeName,
  typeName,
  key
}: {
  inputArg: { [key: string]: any };
  previousInputArg: { [key: string]: any };
  introspectionResults: IntrospectionResult;
  parentTypeName: string;
  typeName: string;
  key: string;
}) => {
  // TODO: Handle delete

  const hasConnect = hasMutationInputType(
    introspectionResults,
    parentTypeName,
    key,
    PRISMA_CONNECT
  );

  const hasCreate = hasMutationInputType(
    introspectionResults,
    parentTypeName,
    key,
    PRISMA_CREATE
  );

  const hasUpdate = hasMutationInputType(
    introspectionResults,
    parentTypeName,
    key,
    PRISMA_UPDATE
  );

  const hasDelete = hasMutationInputType(
    introspectionResults,
    parentTypeName,
    key,
    PRISMA_DELETE
  );

  const hasDisconnect = hasMutationInputType(
    introspectionResults,
    parentTypeName,
    key,
    PRISMA_DISCONNECT
  );

  const hasId = !!inputArg.id
  const hadId = !!previousInputArg.id

  // We should delete/disconnect in case of empty id based on the previous data
  if (!hasId && hadId) {
    // Prefer disconnect over delete
    const mutationType = hasDisconnect ? PRISMA_DISCONNECT : hasDelete ? PRISMA_DELETE : null

    if (!mutationType) {
      return {}
    }

    return {
      [key]: {
        [mutationType]: {
          id: previousInputArg.id
        }
      }
    };
  }

  const hasAdditionalFields = Object.keys(inputArg).some(field => field !== 'id')

  // Has id but doesnt have any additional fields
  const isConnect = hasConnect && hasId && (!hasAdditionalFields || (!hasCreate && !hasUpdate))
  // Has id and additional fields
  const isUpdate = hasUpdate && hasId && hasAdditionalFields
  // Has additional fields but not id
  const isCreate = hasCreate && !hasId && hasAdditionalFields

  const mutationType =
    [PRISMA_CONNECT, PRISMA_UPDATE, PRISMA_CREATE]
    [[isConnect, isUpdate, isCreate].indexOf(true)];

  if (!mutationType) {
    return {}
  }

  let fields = buildReferenceField({
    inputArg,
    previousInputArg,
    introspectionResults,
    parentTypeName,
    typeName,
    field: key,
    mutationType
  });

  // If no fields in the object are valid, continue
  if (Object.keys(fields).length === 0) {
    return {};
  }

  // Else, connect the nodes
  return {
    [key]: { [mutationType]: fields }
  };
};

type Params = { [key: string]: any }

interface UpdateParams {
  data: Params;
  previousData: Params;
}

interface Operations {
  [PRISMA_CREATE]?: any
  [PRISMA_CONNECT]?: any
  [PRISMA_DELETE]?: any
  [PRISMA_SET]?: any
  [PRISMA_UPDATE]?: any
  [PRISMA_DISCONNECT]?: any
}

const traverseVariables = (
  introspectionResults: IntrospectionResult,
  parentTypeName: string,
  params: UpdateParams,
  key: string,
  acc: any
): { where: Params, data: Params } => {
  // Put id field in a where object
  if (key === 'id') {
    if (params.data[key]) {
      return {
        ...acc,
        where: {
          id: params.data[key]
        }
      };
    }

    // Ignore when id is null or undefined
    return acc
  }

  const currentInputField = findInputFieldForType(
    introspectionResults,
    parentTypeName,
    key
  );

  if (!currentInputField) {
    console.warn(`Field (${key}) not found on type ${parentTypeName}`)

    return acc;
  }

  const parentInputType = introspectionResults.types.find(t => t.name === parentTypeName) as IntrospectionInputObjectType
  const currentType = introspectionResults.types.find(t => t.name === currentInputField.name) as IntrospectionInputObjectType

  if (currentInputField.kind === 'SCALAR' || currentInputField.kind === 'ENUM') {
    return {
      ...acc,
      data: {
        ...acc.data,
        [key]: params.data[key]
      }
    };
  }

  if (Array.isArray(params.data[key])) {
    const previous = ((params.previousData || {})[key] || []) as Array<Params>
    const current = params.data[key] as Array<Params>

    const maybeEnumList = findInputFieldForType(introspectionResults, currentType.name, PRISMA_SET)

    if (maybeEnumList && maybeEnumList.kind === 'ENUM') {
      return {
        ...acc,
        data: {
          ...acc.data,
          [key]: {
            set: params.data[key]
          }
        }
      }
    }

    // Connect data with only ID field
    const fieldsToConnect = current.filter(f => f.hasOwnProperty('id') && Object.keys(f).length === 1)

    if (fieldsToConnect.length) {
      const operation = currentType.inputFields.some(f => f.name === PRISMA_SET) ? PRISMA_SET : PRISMA_CONNECT;

      return {
        ...acc,
        data: {
          ...acc.data,
          [key]: {
            [operation]: fieldsToConnect
          }
        }
      };
    }

    const operations: Operations = {}

    const currentIds = current.map(c => c.id)

    // It must be created if doesnt have id
    const fieldsToCreate = current.filter(f => !f.id)
    const fieldsToDelete = previous.map(f => f.id)
      .filter(id => !currentIds.includes(id))
      .map(id => ({ id }))
    const fieldsToUpdate = current.filter(f => f.id)
      .filter(f => !fieldsToDelete.includes(f.id))


    const createType = currentType.inputFields.find(t => t.name === PRISMA_CREATE)

    if (createType) {
      const finalType = getFinalType(createType.type)

      operations[PRISMA_CREATE] = fieldsToCreate.map(field => Object.keys(field).reduce(
        (acc, key) => traverseVariables(introspectionResults, finalType.name, {
          data: field,
          previousData: {}
        }, key, acc), {} as Params).data)
    }

    const updateType = currentType.inputFields.find(f => f.name === PRISMA_UPDATE);

    if (updateType) {
      const finalUpdateType = getFinalType(updateType.type)
      const wapperType = introspectionResults.types.find(t => t.name === finalUpdateType.name) as IntrospectionInputObjectType
      const dataType = wapperType.inputFields.find(i => i.name === "data")

      if (!dataType) {
        return acc
      }

      const finalDataType = getFinalType(dataType.type)

      operations[PRISMA_UPDATE] = fieldsToUpdate.map(item => Object.keys(item).reduce(
        (acc, key) => traverseVariables(introspectionResults, finalDataType.name, {
          data: item,
          previousData: previous.find(f => f.id === item.id) || {}
        }, key, acc), {} as Params)
      )
    }

    const hasDeleteOperation = currentType.inputFields.some(f => f.name === PRISMA_DELETE);
    const hasDisconnectOperation = currentType.inputFields.some(f => f.name === PRISMA_DISCONNECT);

    if (fieldsToDelete.length && hasDeleteOperation && hasDisconnectOperation) {
      console.error('Both delete and disconnect operations exist for type: ' + currentType.name)
    }

    if (hasDisconnectOperation) {
      operations[PRISMA_DISCONNECT] = fieldsToDelete
    }
    else if (hasDeleteOperation) {
      operations[PRISMA_DELETE] = fieldsToDelete
    }

    const nonEmptyOperations = Object.entries(operations).reduce((acc, [operation, arr]) => {
      if (!arr.length) {
        return acc
      }

      return {
        ...acc,
        [operation]: arr
      }
    }, {})

    if (!Object.keys(nonEmptyOperations).length) {
      return acc
    }

    return {
      ...acc,
      data: {
        ...acc.data,
        [key]: nonEmptyOperations
      }
    };
  }

  if (isObject(params.data[key])) {
    const data = buildObjectMutationData({
      inputArg: params.data[key],
      previousInputArg: params.previousData[key] || {},
      introspectionResults,
      parentTypeName,
      typeName: currentInputField.name,
      key
    });

    return {
      ...acc,
      data: {
        ...acc.data,
        ...data
      }
    };
  }

  return acc
}

const buildUpdateVariables = (introspectionResults: IntrospectionResult) => (
  resource: Resource,
  aorFetchType: String,
  params: UpdateParams
) => {
  const typeName = `${resource.type.name}UpdateInput`

  return Object.keys(params.data).reduce(
    (acc, key) => traverseVariables(introspectionResults, typeName, params, key, acc),
    {} as Params
  );
};

interface CreateParams {
  data: Params;
}

const buildCreateVariables = (introspectionResults: IntrospectionResult) => (
  resource: Resource,
  aorFetchType: string,
  params: CreateParams
) => {
  const typeName = `${resource.type.name}CreateInput`

  return Object.keys(params.data).reduce(
    (acc, key) => traverseVariables(introspectionResults, typeName, {
      data: params.data,
      previousData: {}
    }, key, acc),
    {} as Params
  )
};

export default (introspectionResults: IntrospectionResult) => (
  resource: Resource,
  aorFetchType: string,
  params: any
) => {
  switch (aorFetchType) {
    case GET_LIST: {
      return buildGetListVariables(introspectionResults)(
        resource,
        aorFetchType,
        params
      );
    }
    case GET_MANY:
      return {
        where: { id_in: params.ids }
      };
    case GET_MANY_REFERENCE: {
      const parts = params.target.split('.');

      return {
        where: { [parts[0]]: { id: params.id } }
      };
    }
    case GET_ONE:
      return {
        where: { id: params.id }
      };
    case UPDATE: {
      return buildUpdateVariables(introspectionResults)(
        resource,
        aorFetchType,
        params
      );
    }

    case CREATE: {
      return buildCreateVariables(introspectionResults)(
        resource,
        aorFetchType,
        params
      );
    }

    case DELETE:
      return {
        where: { id: params.id }
      };
  }
};
