function buildOpenApiSpec(serverUrl) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Smart Guide Backend API',
      version: '1.0.0',
      description: 'API documentation for Smart Guide backend routes.',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    paths: {
      '/api/health': {
        get: {
          summary: 'Backend health',
          responses: {
            200: { description: 'OK' },
          },
        },
      },
      '/api/supabase/health': {
        get: {
          summary: 'Supabase config health',
          responses: {
            200: { description: 'OK' },
          },
        },
      },
      '/api/supabase/proxy': {
        post: {
          summary: 'Proxy GET requests to allowed Supabase rest/v1 tables',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', example: 'rest/v1/plans?select=*&limit=10' },
                    method: { type: 'string', example: 'GET' },
                    body: { type: 'object' },
                    headers: { type: 'object' },
                  },
                  required: ['path'],
                },
              },
            },
          },
          responses: {
            200: { description: 'Proxy response from Supabase' },
            401: { description: 'Unauthorized' },
            403: { description: 'Forbidden table/path' },
          },
        },
      },
      '/api/supabase/functions/invoke': {
        post: {
          summary: 'Invoke allowed Supabase edge function',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', example: 'contact-form' },
                    body: { type: 'object' },
                  },
                  required: ['name'],
                },
              },
            },
          },
          responses: {
            200: { description: 'Function response' },
            403: { description: 'Function not allowed' },
          },
        },
      },
      '/api/supabase/rpc/{name}': {
        post: {
          summary: 'Invoke allowed RPC',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'name',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
          responses: {
            200: { description: 'RPC response' },
            401: { description: 'Unauthorized' },
            403: { description: 'RPC not allowed or forbidden payload' },
          },
        },
      },
      '/api/supabase/db/profiles/ensure': {
        post: {
          summary: 'Ensure current user profile exists',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'Profile exists/created' },
            401: { description: 'Unauthorized' },
          },
        },
      },
      '/api/supabase/db/favorites': {
        get: {
          summary: 'Get favorites',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'user_id', in: 'query', schema: { type: 'string' } },
            { name: 'plan_id', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'Favorites list' } },
        },
        post: {
          summary: 'Add favorite',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { plan_id: { type: 'string' } },
                  required: ['plan_id'],
                },
              },
            },
          },
          responses: { 200: { description: 'Favorite created' }, 401: { description: 'Unauthorized' } },
        },
        delete: {
          summary: 'Remove favorite',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { plan_id: { type: 'string' } },
                  required: ['plan_id'],
                },
              },
            },
          },
          responses: { 200: { description: 'Favorite removed' }, 401: { description: 'Unauthorized' } },
        },
      },
      '/api/supabase/db/user_lists': {
        get: {
          summary: 'Get user lists',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'Lists' } },
        },
        post: {
          summary: 'Create user list',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'List created' } },
        },
      },
      '/api/supabase/db/list_items': {
        get: {
          summary: 'Get list items',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'List items' } },
        },
        post: {
          summary: 'Add plan to list',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'List item added' } },
        },
        delete: {
          summary: 'Remove plan from list',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'List item removed' } },
        },
      },
      '/api/supabase/db/reviews': {
        post: {
          summary: 'Create/update review',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'Review upserted' }, 401: { description: 'Unauthorized' } },
        },
      },
      '/api/supabase/db/admin/plans': {
        get: {
          summary: 'Admin: list plans',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'Admin plans list' }, 403: { description: 'Admin required' } },
        },
      },
      '/api/supabase/db/admin/reviews': {
        get: {
          summary: 'Admin: list reviews',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'Admin reviews list' }, 403: { description: 'Admin required' } },
        },
      },
      '/api/supabase/db/admin/content_reports': {
        get: {
          summary: 'Admin: list content reports',
          security: [{ bearerAuth: [] }],
          responses: { 200: { description: 'Admin reports list' }, 403: { description: 'Admin required' } },
        },
      },
    },
  };
}

module.exports = { buildOpenApiSpec };
