import { Context } from 'hono';
import type { Env } from './index';

/**
 * Sanitizes an identifier by removing all non-alphanumeric characters except underscores.
 */
function sanitizeIdentifier(identifier: string): string {
    return identifier.replace(/[^a-zA-Z0-9_]/g, '');
}

/**
 * Processing when the table name is a keyword in SQLite.
 */
function sanitizeKeyword(identifier: string): string {
    return '`'+sanitizeIdentifier(identifier)+'`';
}

/**
 * Handles GET requests to fetch records from a table
 */
async function handleGet(c: Context<{ Bindings: Env }>, tableName: string, id?: string): Promise<Response> {
    const table = sanitizeKeyword(tableName);
    const searchParams = new URL(c.req.url).searchParams;
    
    try {
        let query = `SELECT * FROM ${table}`;
        const params: any[] = [];
        const conditions: string[] = [];

        // Handle ID filter
        if (id) {
            conditions.push('id = ?');
            params.push(id);
        }

        // Handle search parameters (basic filtering)
        for (const [key, value] of searchParams.entries()) {
            if (['sort_by', 'order', 'limit', 'offset'].includes(key)) continue;
            
            const sanitizedKey = sanitizeIdentifier(key);
            conditions.push(`${sanitizedKey} = ?`);
            params.push(value);
        }

        // Add WHERE clause if there are conditions
        if (conditions.length > 0) {
            query += ` WHERE ${conditions.join(' AND ')}`;
        }

        // Handle sorting
        const sortBy = searchParams.get('sort_by');
        if (sortBy) {
            const order = searchParams.get('order')?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
            query += ` ORDER BY ${sanitizeIdentifier(sortBy)} ${order}`;
        }

        // Handle pagination
        const limit = searchParams.get('limit');
        if (limit) {
            query += ` LIMIT ?`;
            params.push(parseInt(limit));

            const offset = searchParams.get('offset');
            if (offset) {
                query += ` OFFSET ?`;
                params.push(parseInt(offset));
            }
        }

        const results = await c.env.DB.prepare(query)
            .bind(...params)
            .all();

        return c.json(results);
    } catch (error: any) {
        return c.json({ error: error.message }, 500);
    }
}

/**
 * Handles POST requests to create new records
 */
async function handlePost(c: Context<{ Bindings: Env }>, tableName: string): Promise<Response> {
    const table = sanitizeKeyword(tableName);
    const data = await c.req.json();

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return c.json({ error: 'Invalid data format' }, 400);
    }

    try {
        const columns = Object.keys(data).map(sanitizeIdentifier);
        const placeholders = columns.map(() => '?').join(', ');
        const query = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
        const params = columns.map(col => data[col]);

        const result = await c.env.DB.prepare(query)
            .bind(...params)
            .run();

        return c.json({ message: 'Resource created successfully', data }, 201);
    } catch (error: any) {
        return c.json({ error: error.message }, 500);
    }
}

/**
 * Handles PUT/PATCH requests to update records
 */
async function handleUpdate(c: Context<{ Bindings: Env }>, tableName: string, id: string): Promise<Response> {
    const table = sanitizeKeyword(tableName);
    const data = await c.req.json();

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return c.json({ error: 'Invalid data format' }, 400);
    }

    try {
        const setColumns = Object.keys(data)
            .map(sanitizeIdentifier)
            .map(col => `${col} = ?`)
            .join(', ');

        const query = `UPDATE ${table} SET ${setColumns} WHERE id = ?`;
        const params = [...Object.values(data), id];

        const result = await c.env.DB.prepare(query)
            .bind(...params)
            .run();

        return c.json({ message: 'Resource updated successfully', data });
    } catch (error: any) {
        return c.json({ error: error.message }, 500);
    }
}

/**
 * Handles DELETE requests to remove records
 */
async function handleDelete(c: Context<{ Bindings: Env }>, tableName: string, id: string): Promise<Response> {
    const table = sanitizeKeyword(tableName);

    try {
        const query = `DELETE FROM ${table} WHERE id = ?`;
        const result = await c.env.DB.prepare(query)
            .bind(id)
            .run();

        return c.json({ message: 'Resource deleted successfully' });
    } catch (error: any) {
        return c.json({ error: error.message }, 500);
    }
}

/**
 * Handles GET requests to fetch a value from Alphas
 */
async function handleKvGet(c: Context<{ Bindings: Env }>, id: string): Promise<Response> {
    try {
        const value = await c.env.Alphas.get(id);
        if (value === null) {
            return c.json({ error: 'Key not found' }, 404);
        }
        return c.json({ key: id, value });
    } catch (error: any) {
        return c.json({ error: error.message, "id" : id }, 500);
    }
}

/**
 * Handles GET requests to fetch multiple values from Alphas
 */
async function handleKvGetMultiple(c: Context<{ Bindings: Env }>, kvNamespace: string, keys: string[]): Promise<Response> {
    try {
        // Input validation
        if (!keys?.length) {
            return c.json({ error: 'No keys provided' }, 400);
        }

        if (!c.env[kvNamespace]) {
            return c.json({ 
                error: 'Invalid KV namespace',
                namespace: kvNamespace 
            }, 400);
        }

        const values = await c.env[kvNamespace].get(keys);
        if (!values) {
            return c.json({ 
                error: 'Failed to fetch values',
                namespace: kvNamespace,
                keys
            }, 404);
        }

        const result = keys.reduce<Record<string, any>>((acc, key, index) => {
            const value = values[index];
            if (value !== null && value !== undefined) {
                acc[key] = value;
            }
            return acc;
        }, {});

        if (Object.keys(result).length === 0) {
            return c.json({ 
                error: 'No values found',
                namespace: kvNamespace,
                keys 
            }, 404);
        }

        return c.json({
            success: true,
            namespace: kvNamespace,
            data: result
        });
    } catch (error: any) {
        return c.json({ 
            error: error.message,
            namespace: kvNamespace,
            keys 
        }, 500);
    }
}


async function handleKvPutMultiple(c: Context<{ Bindings: Env }>, kvNamespace: string, data: Record<string, any>): Promise<Response> {
    try {
        if (!data || Object.keys(data).length === 0) {
            return c.json({ error: 'No data provided' }, 400);
        }

        if (!c.env[kvNamespace]) {
            return c.json({ 
                error: 'Invalid KV namespace',
                namespace: kvNamespace 
            }, 400);
        }

        // 批量处理所有键值对
        const entries = Object.entries(data);
        await Promise.all(
            entries.map(([key, value]) => 
                c.env[kvNamespace].put(key, value)
            )
        );

        return c.json({
            success: true,
            namespace: kvNamespace,
            data: {
                processed: entries.length,
                keys: Object.keys(data)
            }
        });
    } catch (error: any) {
        return c.json({ 
            error: error.message,
            namespace: kvNamespace
        }, 500);
    }
}

async function handleKvGetKeys(c: Context<{ Bindings: Env }>, kvNamespace: string): Promise<Response> {
    try {
        if (!c.env[kvNamespace]) {
            return c.json({ 
                error: 'Invalid KV namespace',
                namespace: kvNamespace 
            }, 400);
        }

        let allKeys: string[] = [];
        let cursor: string | null = null;
        let list_complete = false;
    
        do {
            let options: { cursor?: string } = {};
            if (cursor) {
                options.cursor = cursor;
            }
    
            // 列出键
            const value = await c.env[kvNamespace].list(options);
    
            // 将当前获取的键添加到 allKeys 数组中
            allKeys = allKeys.concat(value.keys.map((key: { name: string }) => key.name));
    
            // 更新游标
            cursor = value.cursor;
            list_complete = value.list_complete
        } while (list_complete === false);
    
        return c.json({
            success: true,
            namespace: kvNamespace,
            keys: allKeys,
            total: allKeys.length
        });
        
    } catch (error: any) {
        return c.json({ 
            error: error.message,
            namespace: kvNamespace
        }, 500);
    }
}

/**
 * Main REST handler that routes requests to appropriate handlers
 */
export async function handleRest(c: Context<{ Bindings: Env }>): Promise<Response> {
    const url = new URL(c.req.url);
    const pathParts = url.pathname.split('/').filter(Boolean);
    
    if (pathParts.length < 3) {
        return c.json({ error: 'Invalid path. Expected format: /rest/KV or DB/{KVNamespace} or {tableName}/{keys?} or {id?}' }, 400);
    }

    const Prefix = pathParts[1];
    
    if (Prefix === 'KV') {
        const KVNamespace = pathParts[2];
        switch (c.req.method) {
            case 'GET':
                // Check if multiple keys are provided as query parameters
                const searchParams = new URL(c.req.url).searchParams;
                const keys = searchParams.get('keys');
                
                if (keys) {
                    // Split the comma-separated keys and process them
                    const keyArray = keys.split(',').map(k => k.trim()).filter(Boolean);
                    if (keyArray.length > 0) {
                        return handleKvGetMultiple(c, KVNamespace, keyArray);
                    }
                }
                else {
                    return handleKvGetKeys(c, KVNamespace);
                }

                
                return c.json({ error: 'No keys specified. Use ?keys=key1,key2,key3' }, 400);

            case 'PUT':
                const data = await c.req.json();
                return handleKvPutMultiple(c, KVNamespace, data);
            case 'PATCH':
            case 'DELETE':
            case 'POST':
            default:
                return c.json({ error: 'KV Method not allowed or invalid request format or Invalid path! Expected format: /rest/KV/{KVNamespace}/{keys?}' }, 405);
            }
    }
    else if (Prefix === 'DB') {
        // DB REST OPERATIONS
        const tableName = pathParts[2];
        const id = pathParts[3];
        switch (c.req.method) {
            case 'GET':
                return handleGet(c, tableName, id);
            case 'POST':
                return handlePost(c, tableName);
            case 'PUT':
            case 'PATCH':
                if (!id) return c.json({ error: 'ID is required for updates' }, 400);
                return handleUpdate(c, tableName, id);
            case 'DELETE':
                if (!id) return c.json({ error: 'ID is required for deletion' }, 400);
                return handleDelete(c, tableName, id);
            default:
                return c.json({ error: 'Method not allowed' }, 405);
        }
        
    }
    else {
        return c.json({ error: 'Invalid path. Expected format: /rest/KV or DB/{KVNamespace} or {tableName}/{Key} or {id}' }, 400);
    }
}