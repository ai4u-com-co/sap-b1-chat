import { configureTransport, setServiceName } from "@ai4u/platform/logger"
import { readEnv } from "@/lib/env"

let started = false
export function bootstrapObservability(): void {
  if (started) return
  started = true
  setServiceName("sap-b1-chat")
  const endpoint = readEnv("PLATFORM_INGEST_URL")
  const secret = readEnv("INGEST_SECRET")
  if (endpoint && secret) configureTransport({ endpoint, secret })
}
