import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const key = context.params.key;
  if (!key || !/^[0-9a-f-]{36}(?:\.(?:jpg|png|webp|gif))?$/i.test(key)) return new Response("Not found", { status: 404 });
  const image = await getStore("deal-screenshots").get(key, { type: "arrayBuffer" });
  if (!image) return new Response("Not found", { status: 404 });
  const extension = key.split(".").pop()?.toLowerCase();
  const contentTypes: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
  const contentType = extension && contentTypes[extension] ? contentTypes[extension] : "image/jpeg";
  return new Response(image as ArrayBuffer, {
    headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=31536000, immutable" },
  });
};

export const config: Config = { path: "/api/screenshots/:key" };
