import { NextResponse } from "next/server";
import {
  normalizeSubagentConfig,
  readSubagentConfig,
  writeSubagentConfig,
} from "@/lib/subagent/config";

export const dynamic = "force-dynamic";

/**
 * The subagent worker model.
 *
 * Read on every `subagent` tool invocation rather than held in memory, so
 * changing this takes effect on the next dispatch without restarting the
 * session or the server.
 */
export async function GET() {
  return NextResponse.json(readSubagentConfig());
}

export async function PUT(req: Request) {
  try {
    const body: unknown = await req.json();
    const patch = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const existing = readSubagentConfig();

    // Merge rather than replace. This file is shared by every build installed on
    // the machine, so a client — or an older build that has never heard of a
    // newer field — sending only the keys it knows about must keep the stored
    // values for the rest instead of clearing them.
    const merged = {
      workerModel: Object.hasOwn(patch, "workerModel") ? patch.workerModel : existing.workerModel,
      autoDispatch: Object.hasOwn(patch, "autoDispatch") ? patch.autoDispatch : existing.autoDispatch,
    };

    const config = normalizeSubagentConfig(merged);
    writeSubagentConfig(config);
    return NextResponse.json({ success: true, config });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
