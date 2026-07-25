// Parsea el texto (pdftotext -layout) del PDF diario del NAPIF de Aragón.
// Uso: node parse-napif.mjs <napif.txt> — imprime el JSON por stdout.
import { readFileSync } from 'node:fs'

const MONTHS = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}

const raw = readFileSync(process.argv[2], 'utf8')
// Los saltos de línea del PDF parten frases: se normaliza a una sola línea.
const flat = raw.replace(/\s+/g, ' ')

// Fecha del boletín: "25 de julio de 2026"
const dateMatch = flat.match(/(\d{1,2}) de ([a-zñ]+) de (\d{4})/i)
const day = dateMatch
  ? `${dateMatch[3]}-${String(MONTHS[dateMatch[2].toLowerCase()] ?? 0).padStart(2, '0')}-${String(dateMatch[1]).padStart(2, '0')}`
  : null

// "Zonas en alerta roja hoy (22): texto." / "mañana (7): texto."
// El texto oficial se conserva tal cual (sin interpretarlo) hasta el punto
// final del bloque siguiente.
function redBlock(label) {
  const re = new RegExp(`Zonas en alerta roja ${label} \\((\\d+)\\):\\s*([^.]*(?:\\.[^A-ZÁÉÍÓÚ]|[^.])*?)\\.\\s`, 'i')
  const m = flat.match(re)
  if (!m) return { count: 0, text: null }
  return { count: Number(m[1]), text: `${m[2].trim()}.` }
}

const result = {
  day,
  generatedAt: new Date().toISOString(),
  redToday: redBlock('hoy'),
  redTomorrow: redBlock('mañana'),
}
console.log(JSON.stringify(result, null, 2))
