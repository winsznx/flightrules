import { z } from "zod";
import { apiGet, isFailure } from "@/lib/api";

/**
 * `Export YAML` (PRD section 8.9).
 *
 * A route handler rather than a link straight to the API, for the same reason `lib/api.ts` is
 * `server-only`: the API's address, and any header the product later adds to reach it, stay on the
 * server. The browser asks this application for the document and this application asks the API.
 *
 * The bytes returned are the stored document exactly as validated — `GET /api/contracts/:id/export`
 * returns `yamlText`, not a re-serialisation — so the file a reviewer downloads hashes to the
 * content hash the contract carries.
 */

const ExportSchema = z.object({
  contractId: z.string(),
  contentHash: z.string(),
  yaml: z.string(),
});

export async function GET(
  _request: Request,
  context: { params: Promise<{ contractId: string }> },
): Promise<Response> {
  const { contractId } = await context.params;
  const exported = await apiGet(`/api/contracts/${contractId}/export`, ExportSchema);

  if (isFailure(exported)) {
    return Response.json(
      { error: { code: exported.code, message: exported.message } },
      { status: exported.status ?? 502 },
    );
  }

  return new Response(exported.data.yaml, {
    status: 200,
    headers: {
      "content-type": "application/yaml; charset=utf-8",
      // The content hash travels with the document, so a downloaded file can be tied back to the
      // contract version it came from without opening it.
      "x-flightrules-content-hash": exported.data.contentHash,
      "content-disposition": `attachment; filename="contract-${exported.data.contentHash.slice(0, 12)}.yaml"`,
      "cache-control": "no-store",
    },
  });
}
