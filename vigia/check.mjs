// Vigía de Puedo Rodar: comprueba todos los eslabones de la cadena de datos
// (web, tiles R2, fuentes de riesgo de incendio, Worker, JSONs de las
// Actions). Escribe vigia-report.txt y sale con código 1 si algo falla — el
// workflow abre entonces un issue para avisar al admin.
import { readFileSync, writeFileSync } from 'node:fs'

const hoy = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date())
const ayer = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() - 86400000))
const mes = Number(hoy.slice(5, 7))
// Hora local de Madrid: en lanzamientos manuales fuera del cron (16:30Z) hay
// que relajar los checks de frescura — de madrugada/mañana las fuentes diarias
// (NAPIF 10:15/12:15Z, AEMET 05:15Z) aún no han publicado el dato de hoy y
// «day = ayer» no es avería, es el calendario.
const horaMadrid = Number(new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(11, 13))
const esManana = horaMadrid < 14

const get = (url, opts = {}) => fetch(url, { signal: AbortSignal.timeout(30000), ...opts })

const AND_WMS = 'https://www.juntadeandalucia.es/medioambiente/mapwms/REDIAM_Indice_Riesgo_Incendios_Diario'

// Días de gracia por fuente: las que tienen caídas transitorias documentadas no
// escalan a email al primer tropiezo, solo si el fallo se repite N días
// seguidos. Un rato malo de INFOEX no es una avería; tres días sí.
const GRACIA = {
  'Riesgo Extremadura (Worker+INFOEX)': 3, // servidor MUY inestable, se cae a ratos
  'Avisos País Vasco (Worker+Euskalmet)': 2, // api.euskadi.eus cuelga desde IPs de CF
  'Riesgo La Rioja (Worker)': 2, // ventana de regeneración vespertina de datos.jsp
  'Riesgo Andalucía (Worker+WMS)': 2, // el WMS de la Junta va a ratos
  'Riesgo Asturias (Worker)': 2, // sigvisor publica tarde algunos días
}

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
    if (d.day === ayer && esManana) return // su Action corre a las 10:15/12:15Z
    if (d.day !== hoy) throw new Error(`day ${d.day} ≠ hoy ${hoy} (¿Action rota o PDF no publicado?)`)
  }],
  ['Riesgo AEMET (json de la Action)', async () => {
    const d = await (await get('https://raw.githubusercontent.com/dtelleslopez/puedo-rodar-maps/main/aemet/aemet.json')).json()
    if (d.day !== hoy && !(d.day === ayer && esManana)) throw new Error(`day ${d.day} ≠ hoy ${hoy}`)
    if (d.regions?.madrid?.today == null) throw new Error('madrid sin nivel')
  }],
  ['Riesgo Asturias (Worker)', async () => {
    const d = await (await get('https://puedo-rodar-riesgo.dtelleslopez.workers.dev/asturias')).json()
    if (d.day !== hoy) throw new Error(`day ${d.day} ≠ hoy (¿CSV de sigvisor no publicado?)`)
  }],
  ['Riesgo La Rioja (Worker)', async () => {
    const d = await (await get('https://puedo-rodar-riesgo.dtelleslopez.workers.dev/larioja')).json()
    if (d.day !== hoy) throw new Error(`day ${d.day} ≠ hoy (¿datos.jsp sin referencia de víspera?)`)
  }],
  ['Avisos País Vasco (Worker+Euskalmet)', async () => {
    const d = await (await get('https://puedo-rodar-riesgo.dtelleslopez.workers.dev/euskadi')).json()
    if (d.day !== hoy) throw new Error(`day ${d.day} ≠ hoy (¿JWT caducado o API cambiada?)`)
  }],
  ['Riesgo Andalucía (Worker+WMS)', async () => {
    // REDIAM publica un boletín de TRES DÍAS que empieza en D+1: el emitido el
    // 11-08 tiene capas 12, 13 y 14. O sea que hoy sale de la predicción de
    // AYER, y en cuanto por la tarde entra la de hoy, HOY deja de estar
    // publicado y el Worker responde 502 con toda la razón. Esa rotación cae
    // justo en la ventana del vigía (16:30Z + el retraso del cron de GitHub),
    // así que preguntar "¿tiene el Worker el dato de hoy?" da falsos rojos casi
    // a diario. La pregunta buena es "¿sigue viva y fresca la fuente?".
    const caps = await (await get(`${AND_WMS}?request=getcapabilities&service=WMS`)).text()
    const dias = [...caps.matchAll(/<Name>indice_riesgo_dia_\d<\/Name>\s*<Title>[^<]*?(\d{2})-(\d{2})-(\d{4})/g)]
      .map((m) => `${m[3]}-${m[2]}-${m[1]}`).sort()
    if (dias.length === 0) throw new Error('GetCapabilities sin capas indice_riesgo_dia_N (¿cambió el WMS?)')
    if (dias.at(-1) < hoy) throw new Error(`boletín congelado: la última capa es del ${dias.at(-1)}`)
    const d = await (await get('https://puedo-rodar-riesgo.dtelleslopez.workers.dev/andalucia')).json()
    // Si el boletín TODAVÍA cubre hoy, el Worker tiene que darlo; si ya rotó,
    // el 502 es el comportamiento correcto y la app dirá "no comprobado".
    if (dias.includes(hoy) && d.day !== hoy) {
      throw new Error(`day ${d.day} ≠ hoy con la capa de hoy publicada (¿Worker roto?)`)
    }
  }],
  ['Riesgo Extremadura (Worker+INFOEX)', async () => {
    const d = await (await get('https://puedo-rodar-riesgo.dtelleslopez.workers.dev/extremadura')).json()
    if (d.day !== hoy) throw new Error(`day ${d.day} ≠ hoy (el servidor de INFOEX se cae a menudo)`)
  }],
  ['Alertas Canarias (WP-JSON)', async () => {
    const d = await (await get('https://www3.gobiernodecanarias.org/noticias/wp-json/wp/v2/posts?categories=24&per_page=5&_fields=title,date')).json()
    if (!Array.isArray(d) || d.length === 0) throw new Error('sin posts de alertas')
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
    // Se tolera «ayer»: la JCCM publica a veces DESPUÉS del vigía (visto el
    // 01-08 y el 04-08, este a las 18:23Z vs check a las 18:14Z). El caso que
    // este check debe cazar —el servicio congelado durante meses— sigue
    // saltando igual, como mucho un día más tarde.
    if (editado !== hoy && editado !== ayer) throw new Error(`dataLastEditDate ${editado} ≠ hoy/ayer (¿cambió el año del servicio?)`)
  }],
]

// Dos pasadas: los checks fallados se reintentan UNA vez a los 3 minutos.
// Motivo: varias fuentes tienen transitorios reales a la hora del vigía
// (ventanas de regeneración del boletín en La Rioja/REDIAM, cuelgues
// intermitentes de api.euskadi.eus desde IPs de Cloudflare) que no son
// averías y no merecen email.
const errores = new Map()
for (const [name, fn] of CHECKS) {
  try { await fn() } catch (e) { errores.set(name, e.message) }
}
const recuperados = new Set()
if (errores.size > 0) {
  await new Promise((r) => setTimeout(r, 180000))
  for (const [name] of [...errores]) {
    const [, fn] = CHECKS.find(([n]) => n === name)
    try {
      await fn()
      errores.delete(name)
      recuperados.add(name)
    } catch (e) {
      errores.set(name, `${e.message} (persiste tras reintento a los 3 min)`)
    }
  }
}
// Racha de fallos por check, guardada en vigia/state.json y commiteada por el
// workflow. Sirve para no mandar email por un mal rato de una fuente ajena:
// solo se escala cuando el fallo se repite GRACIA[name] días SEGUIDOS. Un día
// verde borra la racha.
const STATE = new URL('./state.json', import.meta.url)
let estado = {}
try { estado = JSON.parse(readFileSync(STATE, 'utf8')) } catch { /* primera vez */ }

const escalados = new Set()
for (const [name] of CHECKS) {
  if (!errores.has(name)) { delete estado[name]; continue }
  const prev = estado[name]
  const dias = prev?.ultimo === hoy ? prev.dias // relanzado el mismo día: no cuenta doble
    : prev?.ultimo === ayer ? prev.dias + 1 // racha continua
      : 1 // racha nueva (o con hueco: empezamos a contar otra vez)
  estado[name] = { desde: prev?.ultimo === ayer || prev?.ultimo === hoy ? prev.desde : hoy, ultimo: hoy, dias }
  if (dias >= (GRACIA[name] ?? 1)) escalados.add(name)
}
writeFileSync(STATE, `${JSON.stringify(estado, null, 2)}\n`)

const lines = CHECKS.map(([name]) => {
  if (!errores.has(name)) return recuperados.has(name) ? `✅ ${name} (al 2º intento)` : `✅ ${name}`
  const { dias, desde } = estado[name]
  const tope = GRACIA[name] ?? 1
  return escalados.has(name)
    ? `❌ ${name} — ${errores.get(name)}${tope > 1 ? ` [${dias} días seguidos desde ${desde}]` : ''}`
    : `⚠️ ${name} — ${errores.get(name)} [fuente con caídas conocidas: día ${dias} de ${tope}, aún no escalo]`
})
const report = `Vigía Puedo Rodar · ${hoy}\n\n${lines.join('\n')}\n`
console.log(report)
writeFileSync('vigia-report.txt', report)
process.exit(escalados.size > 0 ? 1 : 0)
