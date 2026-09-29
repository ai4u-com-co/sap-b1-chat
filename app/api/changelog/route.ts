import { NextResponse } from "next/server"
import { withApiHandler } from "@ai4u/platform/http"
import { readEnv } from "@/lib/env"

// CHANGELOG_URL acá es la URL COMPLETA del endpoint (…/api/changelog/<tenant>/<app>),
// no la URL base del servicio: por eso se lee con su nombre propio y NO como alias
// de NEXT_PUBLIC_CHANGELOG_URL (que en el contrato es la base que usa el pill).

export const GET = withApiHandler(async (req: Request) => {
  const CHANGELOG_URL = readEnv("CHANGELOG_URL")
  if (!CHANGELOG_URL) {
    return NextResponse.json({ error: "changelog not configured" }, { status: 503 })
  }

  const { searchParams } = new URL(req.url)
  const limit = searchParams.get("limit") ?? "20"

  const res = await fetch(`${CHANGELOG_URL}?limit=${limit}`, {
    next: { revalidate: 300 },
  })

  if (!res.ok) {
    return NextResponse.json({ error: "changelog unavailable" }, { status: res.status })
  }

  const data = await res.json()
  return NextResponse.json(data)
}, { label: "GET changelog" }) as (req: Request) => Promise<Response>
