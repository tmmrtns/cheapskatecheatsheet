import type { Config } from '@netlify/functions'
import { getDatabase } from '@netlify/database'

const categories = new Set([
  'diapers',
  'dishwasher',
  'toiletpaper',
  'kitchentowels',
  'wetwipes',
  'detergent',
  'coffeecups',
])

const json = (data: unknown, status = 200) => Response.json(data, { status })

export default async (req: Request) => {
  const db = getDatabase()
  const pathParts = new URL(req.url).pathname.split('/').filter(Boolean)
  const id = pathParts.length > 2 ? pathParts.at(-1) : null

  try {
    if (req.method === 'GET' && !id) {
      const rows = await db.sql`
        SELECT id, category, subtype, unit_price, inputs,
               EXTRACT(EPOCH FROM created_at) * 1000 AS created_at
        FROM price_check_history
        ORDER BY created_at DESC
      `
      return json(rows.map((row) => ({
        id: row.id,
        category: row.category,
        subtype: row.subtype,
        unitPrice: Number(row.unit_price),
        inputs: row.inputs,
        createdAt: Number(row.created_at),
      })))
    }

    if (req.method === 'POST' && !id) {
      const body = await req.json() as Record<string, unknown>
      const category = typeof body.category === 'string' ? body.category : ''
      const subtype = typeof body.subtype === 'string' && body.subtype.trim() ? body.subtype.trim().slice(0, 120) : null
      const unitPrice = Number(body.unitPrice)
      const inputs = body.inputs

      if (!categories.has(category) || !Number.isFinite(unitPrice) || unitPrice <= 0 ||
          !inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
        return json({ error: 'Invalid price check.' }, 400)
      }

      const inputJson = JSON.stringify(inputs)
      if (inputJson.length > 10_000) return json({ error: 'Price check details are too large.' }, 400)

      const [row] = await db.sql`
        INSERT INTO price_check_history (category, subtype, unit_price, inputs)
        VALUES (${category}, ${subtype}, ${unitPrice}, ${inputJson}::jsonb)
        RETURNING id, category, subtype, unit_price, inputs,
                  EXTRACT(EPOCH FROM created_at) * 1000 AS created_at
      `
      return json({
        id: row.id,
        category: row.category,
        subtype: row.subtype,
        unitPrice: Number(row.unit_price),
        inputs: row.inputs,
        createdAt: Number(row.created_at),
      }, 201)
    }

    if (req.method === 'DELETE' && id) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        return json({ error: 'Invalid price check ID.' }, 400)
      }
      const deleted = await db.sql`DELETE FROM price_check_history WHERE id = ${id} RETURNING id`
      if (!deleted.length) return json({ error: 'Price check not found.' }, 404)
      return new Response(null, { status: 204 })
    }

    return json({ error: 'Method not allowed.' }, 405)
  } catch (error) {
    console.error('Price check request failed', error)
    return json({ error: 'Could not update price-check history.' }, 500)
  }
}

export const config: Config = {
  path: ['/api/price-checks', '/api/price-checks/:id'],
}
