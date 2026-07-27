"use client"

import { isTextUIPart, type UIMessage } from "ai"
import { useCallback, useEffect, useState } from "react"

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface Thread {
  id: string
  title: string
  messages: UIMessage[]
  createdAt: number
  updatedAt: number
}

// ─── localStorage helpers ─────────────────────────────────────────────────────

const THREADS_KEY = "sap-b1-threads"
const ACTIVE_KEY = "sap-b1-active-thread"

function readStorage(): Thread[] {
  try {
    const raw = localStorage.getItem(THREADS_KEY)
    return raw ? (JSON.parse(raw) as Thread[]) : []
  } catch {
    return []
  }
}

function writeStorage(threads: Thread[]) {
  localStorage.setItem(THREADS_KEY, JSON.stringify(threads))
}

function generateId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

function titleFromMessages(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === "user")
  if (!first) return "Nueva conversación"
  const text = first.parts
    .filter(isTextUIPart)
    .map((p) => p.text)
    .join("")
    .trim()
  return text.length > 44 ? text.slice(0, 43) + "…" : text || "Nueva conversación"
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
//
// Fundamentos implementados:
//   • Persistencia: hilos guardados en localStorage tras cada respuesta completa
//   • Multi-hilo: lista ordenada por updatedAt desc, con título auto-generado
//     desde el primer mensaje del usuario
//   • Thread lifecycle: create → chat → save on finish → switch / delete
//
export function useThreads() {
  const [threads, setThreads] = useState<Thread[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string>("")

  // Cargar hilos al montar (sólo en cliente)
  useEffect(() => {
    const saved = readStorage()
    const savedActive = localStorage.getItem(ACTIVE_KEY) ?? ""

    if (saved.length > 0) {
      setThreads(saved)
      const hasActive = saved.some((t) => t.id === savedActive)
      setActiveThreadId(hasActive ? savedActive : saved[0].id)
    } else {
      const first = makeNewThread()
      setThreads([first])
      setActiveThreadId(first.id)
      writeStorage([first])
    }
  }, [])

  // Persiste el hilo activo
  useEffect(() => {
    if (activeThreadId) {
      localStorage.setItem(ACTIVE_KEY, activeThreadId)
    }
  }, [activeThreadId])

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null

  // Crear hilo nuevo y activarlo
  const createThread = useCallback((): string => {
    const thread = makeNewThread()
    setThreads((prev) => {
      const updated = [thread, ...prev]
      writeStorage(updated)
      return updated
    })
    setActiveThreadId(thread.id)
    return thread.id
  }, [])

  // Guardar mensajes en el hilo activo (llamado tras status === 'ready')
  const saveMessages = useCallback(
    (threadId: string, messages: UIMessage[]) => {
      setThreads((prev) => {
        const updated = prev.map((t) =>
          t.id !== threadId
            ? t
            : {
                ...t,
                messages,
                title: titleFromMessages(messages) || t.title,
                updatedAt: Date.now(),
              },
        )
        // Ordenar por updatedAt desc para que el más reciente quede arriba
        updated.sort((a, b) => b.updatedAt - a.updatedAt)
        writeStorage(updated)
        return updated
      })
    },
    [],
  )

  // Eliminar un hilo; si era el activo, activar el siguiente
  const deleteThread = useCallback(
    (threadId: string) => {
      setThreads((prev) => {
        const updated = prev.filter((t) => t.id !== threadId)
        if (updated.length === 0) {
          const fallback = makeNewThread()
          writeStorage([fallback])
          setActiveThreadId(fallback.id)
          return [fallback]
        }
        writeStorage(updated)
        if (threadId === activeThreadId) {
          setActiveThreadId(updated[0].id)
        }
        return updated
      })
    },
    [activeThreadId],
  )

  // Renombrar un hilo manualmente
  const renameThread = useCallback((threadId: string, newTitle: string) => {
    const title = newTitle.trim()
    if (!title) return
    setThreads((prev) => {
      const updated = prev.map((t) =>
        t.id === threadId ? { ...t, title } : t,
      )
      writeStorage(updated)
      return updated
    })
  }, [])

  return {
    threads,
    activeThreadId,
    activeThread,
    setActiveThreadId,
    createThread,
    saveMessages,
    deleteThread,
    renameThread,
  }
}

function makeNewThread(): Thread {
  return {
    id: generateId(),
    title: "Nueva conversación",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}
