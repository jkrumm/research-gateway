type Fields = Record<string, unknown>

export function log(event: string, fields: Fields = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
}
