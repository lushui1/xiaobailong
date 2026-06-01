// capabilities/tool-audit.js - stub
export function inferToolStatus(result) {
  if (result?.error || result?.ok === false) return 'error'
  return 'success'
}

export function writeToolAuditLog(entry) {
  // audit logging disabled
}
