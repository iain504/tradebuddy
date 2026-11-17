import { decodeServersDat, decodeSrv } from "@/lib/brokers";
import { err, json } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/srv/decode
 * Body: multipart "file" field (or raw bytes), optional "server" field.
 *
 * Accepts two file formats:
 *  1. A broker .srv file -> returns that broker's name + endpoint list.
 *  2. The terminal's config\servers.dat (newer MT4/MT5 builds no longer write
 *     per-broker .srv files) -> returns the full server catalog, or, when the
 *     "server" field names one entry, that server's endpoint list.
 */
export async function POST(req: Request) {
  try {
    const ct = req.headers.get("content-type") || "";
    let buf: Buffer | null = null;
    let filename = "";
    let serverParam = new URL(req.url).searchParams.get("server") || "";

    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return err("multipart field 'file' required");
      filename = file.name;
      const s = form.get("server");
      if (typeof s === "string" && s) serverParam = s;
      buf = Buffer.from(await file.arrayBuffer());
    } else {
      const ab = await req.arrayBuffer();
      if (ab.byteLength === 0) return err("empty body - send the .srv file bytes");
      buf = Buffer.from(ab);
      filename = req.headers.get("x-filename") || "uploaded.srv";
    }
    if (!buf) return err("no file received");

    // servers.dat catalogs reach several MB; .srv files are tiny.
    if (buf.length > 32 * 1024 * 1024) return err("file too large (max 32 MB)");

    // 1) Single-broker .srv decode (skipped when a specific servers.dat entry
    //    was requested, since both are binary blobs).
    if (!serverParam) {
      const decoded = decodeSrv(buf);
      if (decoded) {
        return json({
          ok: true,
          kind: "srv" as const,
          filename,
          name: decoded.name,
          endpoints: decoded.endpoints,
        });
      }
    }

    // 2) Terminal servers.dat catalog.
    const servers = decodeServersDat(buf);
    if (servers) {
      if (serverParam) {
        const needle = serverParam.trim().toLowerCase();
        const found = servers.find((s) => s.name.toLowerCase() === needle);
        if (!found) {
          return json(
            { ok: false, error: `Server "${serverParam}" not found in this servers.dat`, filename },
            404
          );
        }
        return json({
          ok: true,
          kind: "servers-dat" as const,
          filename,
          name: found.name,
          endpoints: found.endpoints,
        });
      }
      return json({
        ok: true,
        kind: "servers-dat" as const,
        filename,
        servers: servers.slice(0, 5000).map((s) => ({
          name: s.name,
          company: s.company,
          endpointCount: s.endpoints.length,
        })),
      });
    }

    return json(
      {
        ok: false,
        error:
          "Could not decode this file (.srv and servers.dat formats both tried). " +
          "You can still connect MT5 by server label, or enter host:port manually for MT4.",
        filename,
      },
      422
    );
  } catch (e) {
    console.error("[srv.decode]", e);
    return err("Decode failed", 500);
  }
}
