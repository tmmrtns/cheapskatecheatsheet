import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";
import { randomUUID } from "node:crypto";

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) return Response.json({ error: "Only images are supported" }, { status: 415 });
  const data = await req.arrayBuffer();
  if (!data.byteLength || data.byteLength > 5 * 1024 * 1024) return Response.json({ error: "Image must be under 5 MB" }, { status: 413 });
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  };
  const extension = extensions[contentType.split(";")[0].toLowerCase()];
  if (!extension) return Response.json({ error: "Unsupported image format" }, { status: 415 });
  const key = `${randomUUID()}.${extension}`;
  await getStore("deal-screenshots").set(key, data);
  return Response.json({ key }, { status: 201 });
};

export const config: Config = { path: "/api/screenshots" };
