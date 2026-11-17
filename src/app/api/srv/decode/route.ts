import { decodeSrv } from "@/lib/brokers";
import { err, json } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * POST /api/srv/decode
 * Body: raw bytes of a broker .srv file (multipart "file" field or raw body).
 * Returns the decoded broker name + access server endpoints (host:port list).
 */
export async function POST(req: Request) {
  try {
    const ct = req.headers.get("content-type") || "";
    let buf: Buffer | null = null;
    let filename = "";

    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return err("multipart field 'file' required");
      filename = file.name;
      buf = Buffer.from(await file.arrayBuffer());
    } else {
      const ab = await req.arrayBuffer();
      if (ab.byteLength === 0) return err("empty body - send the .srv file bytes");
      buf = Buffer.from(ab);
      filename = req.headers.get("x-filename") || "uploaded.srv";
    }

    if (buf && buf.length > 2 * 1024 * 1024) return err("file too large");
    const decoded = buf ? decodeSrv(buf) : null;
    if (!decoded) {
      return json(
        {
          ok: false,
          error:
            "Could not decode this .srv file (unknown format). You can still connect MT5 by server label, or enter host:port manually for MT4.",
          filename,
        },
        422
      );
    }
    return json({ ok: true, filename, name: decoded.name, endpoints: decoded.endpoints });
  } catch (e) {
    console.error("[srv.decode]", e);
    return err("Decode failed", 500);
  }
}
