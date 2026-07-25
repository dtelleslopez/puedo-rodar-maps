// Vigía de Puedo Rodar: comprueba todos los eslabones de la cadena de datos
// (web, tiles R2, fuentes de riesgo de incendio, Worker, JSONs de las
// Actions). Escribe vigia-report.txt y sale con código 1 si algo falla — el
// workflow abre entonces un issue para avisar al admin.
import { writeFileSync } from 'node:fs'

const hoy = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date())
const mes = Number(hoy.slice(5, 7))

const get = (url, opts = {}) => fetch(url, { signal: AbortSignal.timeout(30000), ...opts })

const CHECKS = [
  ['web puedorodar.com/app', async () => {
    const res = await get('https://puedorodar.com/app/')
    const html = await res.text()
    if (!res.ok || !html.includes('/assets/app-')) throw new Error(`status ${res.status} o bundle ausente`)
  }],
  ['tiles R2 spain.pmtiles (range)', async () => {
    const res = await get('https://tiles.puedorodar.com/spain.pmtiles', { headers: { Range: 'bytes=0-6' } })
    const body = await res.text()
    if (res.status !== 206 || !body.startsWith('PMTiles')) throw new Error(`status ${res.status} body "${body.slice(0, 10)}"`)
  }],
  ['tiles R2 comunidad offline', async () => {
    const res = await get('https://tiles.puedorodar.com/la-rioja.pmtiles', { method: 'HEAD' })
    if (!res.ok) throw new Error(`status ${res.status}`)
  }],
  ['Pla Alfa niveles (ArcGIS)', async () => {
    const d = await (await get('https://services7.arcgis.com/ZCqVt1fRXwwK6GF4/arcgis/rest/services/Pla_Alfa_Municipal_Avui_FL_2_view/FeatureServer/0/query?where=1%3D1&groupByFieldsForStatistics=PERIL_M&outStatistics=%5B%7B%22statisticType%22%3A%22count%22%2C%22onStatisticField%22%3A%22FID%22%2C%22outStatisticFieldName%22%3A%22n%22%7D%5D&f=json')).json()
    if (!Array.isArray(d.features) || d.features.length === 0) throw new Error('sin features')
  }],
  ['Pla Alfa cierres (ArcGIS)', async () => {
    const d = await (await get('https://services7.arcgis.com/ZCqVt1fRXwwK6GF4/arcgis/rest/services/tancaments_pla_alfa_avui_VW/FeatureServer/2/query?where=Avui%3D1&outFields=Espai_prot&outSR=4326&f=geojson')).json()
    if (d?.type !== 'FeatureCollection') throw new Error('no es FeatureCollection')
  }],
  ['Previfoc (Worker proxy)', async () => {
    const d = await (await get('https://puedo-rodar-previfoc.dtelleslopez.workers.dev/previfoc')).json()
    if (!Array.isArray(d.z1) || d.z1.length === 0) throw new Error('z1 vacío')
  }],
  ['NAPIF Aragón (json de la Action)', async () => {
    const d = await (await get('https://raw.githubusercontent.com/dtelleslopez/puedo-rodar-maps/main/napif/napif.json')).json()
    if (d.day !== hoy) throw new Error(`day ${d.day} ≠ hoy ${hoy} (¿Action rota o PDF no publicado?)`)
  }],
  ['Riesgo AEMET (json de la Action)', async () => {
    const d = await (await get('https://raw.githubusercontent.com/dtelleslopez/puedo-rodar-maps/main/aemet/aemet.json')).json()
    if (d.day !== hoy) throw new Error(`day ${d.day} ≠ hoy ${hoy}`)
    if (d.regions?.madrid?.today == null) throw new Error('madrid sin nivel')
  }],
  ['Riesgo Navarra (WFS)', async () => {
    const d = await (await get('https://inspire.navarra.es/services/riesgoIncendios/wfs?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json&propertyName=IdRiesgo&typeNames=riesgoIncendios:vw_riesgomunicipiod0&count=5')).json()
    if (!Array.isArray(d.features) || d.features.length === 0) throw new Error('sin features')
  }],
  ['IPP C-LM (ArcGIS, solo campaña jun-sep)', async () => {
    if (mes < 6 || mes > 9) return
    const d = await (await get('https://services-eu1.arcgis.com/LVA9E9zjh6QfM7Mo/arcgis/rest/services/IPP_Administrativo_Web_Vista_2025/FeatureServer/0?f=json')).json()
    const editado = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' })
      .format(new Date(Number(d?.editingInfo?.dataLastEditDate)))
    if (editado !== hoy) throw new Error(`dataLastEditDate ${editado} ≠ hoy (¿cambió el año del servicio?)`)
  }],
]

const lines = []
let fallos = 0
for (const [name, fn] of CHECKS) {
  try {
    await fn()
    lines.push(`✅ ${name}`)
  } catch (e) {
    fallos++
    lines.push(`❌ ${name} — ${e.message}`)
  }
}
const report = `Vigía Puedo Rodar · ${hoy}\n\n${lines.join('\n')}\n`
console.log(report)
writeFileSync('vigia-report.txt', report)
process.exit(fallos > 0 ? 1 : 0)
