// capabilities/abort-utils.js - stub
export function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error(signal.reason || 'Aborted')
    err.name = 'AbortError'
    throw err
  }
}
