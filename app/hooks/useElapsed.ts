"use client"

import { useEffect, useRef, useState } from "react"

// ─── Hook: cronómetro para tool calls pendientes ──────────────────────────────
export function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number | null>(null)
  useEffect(() => {
    if (!active) { startRef.current = null; setElapsed(0); return }
    startRef.current = Date.now()
    const id = setInterval(() => {
      if (startRef.current !== null) setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 500)
    return () => clearInterval(id)
  }, [active])
  return elapsed
}
