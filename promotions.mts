import type { Config } from '@netlify/functions'
import { getDatabase } from '@netlify/database'

const json = (data: unknown, status = 200) => Response.json(data, { status })
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type PromotionRow = Record<string, any>

const toDateOnly = (value: unknown) => {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) {
    const year = value.getUTCFullYear()
    const month = String(value.getUTCMonth() + 1).padStart(2, '0')
    const day = String(value.getUTCDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : null
}

const toPromotion = (row: PromotionRow) => ({
  id: row.id, shop: row.shop, item: row.item, discount: row.discount,
  category: row.category, startDate: toDateOnly(row.start_date), endDate: toDateOnly(row.end_date),
  notes: row.notes, imageKey: row.image_key, redeemed: row.redeemed, rank: row.rank,
  createdAt: row.created_at instanceof Date ? row.created_at.getTime() : new Date(String(row.created_at)).getTime(),
})

const cleanText = (value: unknown, max: number, required = false) => {
  if (typeof value !== 'string') return required ? null : undefined
  const cleaned = value.trim().slice(0, max)
  return cleaned || (required ? null : undefined)
}
const cleanDate = (value: unknown) => value === null || value === ''
  ? null
  : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined

export default async (req: Request) => {
  const db = getDatabase()
  const parts = new URL(req.url).pathname.split('/').filter(Boolean)
  const id = parts.length > 2 ? parts.at(-1) : null

  try {
    if (req.method === 'GET' && !id) {
      const requestedToday = new URL(req.url).searchParams.get('today')
      const serverNow = new Date()
      const allowedDates = new Set([-1, 0, 1].map(offset => {
        const date = new Date(serverNow)
        date.setUTCDate(date.getUTCDate() + offset)
        return date.toISOString().slice(0, 10)
      }))
      const cleanedToday = cleanDate(requestedToday)
      const today = cleanedToday && allowedDates.has(cleanedToday)
        ? cleanedToday
        : serverNow.toISOString().slice(0, 10)
      await db.sql`DELETE FROM promotions WHERE end_date < ${today}::date`
      const rows = await db.sql`
        SELECT id, shop, item, discount, category, start_date, end_date,
               notes, image_key, redeemed, rank, created_at
        FROM promotions ORDER BY created_at DESC
      `
      return Response.json(rows.map(toPromotion), {
        headers: { 'Cache-Control': 'no-store' },
      })
    }

    if (req.method === 'POST' && !id) {
      const body = await req.json() as Record<string, unknown>
      const shop = cleanText(body.shop, 160, true)
      const item = cleanText(body.item, 240, true)
      const discount = cleanText(body.discount, 160, true)
      const category = cleanText(body.category, 120) ?? null
      const startDate = cleanDate(body.startDate)
      const endDate = cleanDate(body.endDate)
      const notes = cleanText(body.notes, 2_000) ?? null
      const imageKey = cleanText(body.imageKey, 500) ?? null
      const rank = Number(body.rank)
      const redeemed = body.redeemed === true
      const createdAtNumber = Number(body.createdAt)
      const createdAt = Number.isFinite(createdAtNumber) && createdAtNumber > 0 ? new Date(createdAtNumber) : new Date()
      if (!shop || !item || !discount || !endDate || startDate === undefined || !Number.isInteger(rank) || rank < 1 || rank > 5) {
        return json({ error: 'Invalid promotion.' }, 400)
      }
      const [row] = await db.sql`
        INSERT INTO promotions (shop, item, discount, category, start_date, end_date, notes, image_key, redeemed, rank, created_at)
        VALUES (${shop}, ${item}, ${discount}, ${category}, ${startDate}, ${endDate}, ${notes}, ${imageKey}, ${redeemed}, ${rank}, ${createdAt})
        RETURNING id, shop, item, discount, category, start_date, end_date, notes, image_key, redeemed, rank, created_at
      `
      return json(toPromotion(row), 201)
    }

    if (req.method === 'PATCH' && id) {
      if (!uuidPattern.test(id)) return json({ error: 'Invalid promotion ID.' }, 400)
      const body = await req.json() as Record<string, unknown>
      const [existing] = await db.sql`SELECT * FROM promotions WHERE id = ${id}`
      if (!existing) return json({ error: 'Promotion not found.' }, 404)
      const shop = body.shop === undefined ? existing.shop : cleanText(body.shop, 160, true)
      const item = body.item === undefined ? existing.item : cleanText(body.item, 240, true)
      const discount = body.discount === undefined ? existing.discount : cleanText(body.discount, 160, true)
      const category = body.category === undefined ? existing.category : cleanText(body.category, 120) ?? null
      const startDate = body.startDate === undefined ? existing.start_date : cleanDate(body.startDate)
      const endDate = body.endDate === undefined ? existing.end_date : cleanDate(body.endDate)
      const notes = body.notes === undefined ? existing.notes : cleanText(body.notes, 2_000) ?? null
      const imageKey = body.imageKey === undefined ? existing.image_key : cleanText(body.imageKey, 500) ?? null
      const redeemed = body.redeemed === undefined ? existing.redeemed : body.redeemed === true
      const rank = body.rank === undefined ? Number(existing.rank) : Number(body.rank)
      if (!shop || !item || !discount || !endDate || startDate === undefined || !Number.isInteger(rank) || rank < 1 || rank > 5) {
        return json({ error: 'Invalid promotion.' }, 400)
      }
      const [row] = await db.sql`
        UPDATE promotions SET shop = ${shop}, item = ${item}, discount = ${discount}, category = ${category},
          start_date = ${startDate}, end_date = ${endDate}, notes = ${notes}, image_key = ${imageKey},
          redeemed = ${redeemed}, rank = ${rank}
        WHERE id = ${id}
        RETURNING id, shop, item, discount, category, start_date, end_date, notes, image_key, redeemed, rank, created_at
      `
      return json(toPromotion(row))
    }

    if (req.method === 'DELETE' && id) {
      if (!uuidPattern.test(id)) return json({ error: 'Invalid promotion ID.' }, 400)
      const deleted = await db.sql`DELETE FROM promotions WHERE id = ${id} RETURNING id`
      if (!deleted.length) return json({ error: 'Promotion not found.' }, 404)
      return new Response(null, { status: 204 })
    }
    if (req.method === 'DELETE' && !id) {
      await db.sql`DELETE FROM promotions`
      return new Response(null, { status: 204 })
    }
    return json({ error: 'Method not allowed.' }, 405)
  } catch (error) {
    console.error('Promotion request failed', error)
    return json({ error: 'Could not update promotions.' }, 500)
  }
}

export const config: Config = { path: ['/api/promotions', '/api/promotions/:id'] }
