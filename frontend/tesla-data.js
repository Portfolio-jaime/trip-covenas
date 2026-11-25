// Datos de la ruta Medellín → Coveñas en Tesla Model Y RWD.
//
// Fuentes: reportes reales de conductores en los grupos de WhatsApp "Viajes" y
// "Viajes y Rutas" (Tesla Colombia Motors Club, mayo–octubre 2026), los
// números de la propia ruta de Andrés en ABRP (457,6 km Poblado→Montería) y
// distancias por carretera de rome2rio. Todo lo que no esté confirmado por
// conductores está marcado como "hipotesis" o "sin verificar".
//
// Los consumos (Wh/km) están calibrados contra los reportes (actualizado 2026-11-25):
//   Popalito 100% → Fátima: gastó 53–75% (la mayoría 65–70%) → 140 Wh/km, llega ≈ 29% en estilo Normal.
//   Popalito 100% → Montería (RWD, suave): llegó con 14–15% → coincide con estilo "Eco".
//   Fátima 100% → Popalito (regreso): llegó con 4–36% según velocidad (64–96% gastado) → factor de subida 1,15.
//   Fátima → Rincón del Mar / Coveñas: 50–68% gastado en AWD (~195 km) → tramos del Caribe subidos
//   (155 y 170 Wh/km) porque el calor y el A/C pesan más que en la montaña.
// Ojo: los bots (Optimus) y ABRP son más optimistas que la realidad; los reportes de conductores mandan.
window.TESLA_DATA = {
  vehicle: { usableKwh: 60, note: "Model Y RWD (LFP). Capacidad útil asumida, editable." },

  // Estilo de manejo: multiplica consumo y cambia velocidad media (con pueblos y peajes).
  styles: {
    eco:    { label: "Eco (≤ 90 km/h, A/C 24 °C)", mult: 0.88, avgKmh: 66 },
    normal: { label: "Normal (≈ 100 km/h)",        mult: 1.00, avgKmh: 70 },
    rapido: { label: "Rápido (110–120 km/h)",      mult: 1.20, avgKmh: 76 }
  },

  // Carga: pasajeros + equipaje.
  loads: {
    liviano: { label: "2 personas, poco equipaje", mult: 0.97 },
    medio:   { label: "4 personas + maletas",      mult: 1.03 },
    lleno:   { label: "5 personas + maletero lleno", mult: 1.08 }
  },

  // Escenario de qué tan bien se portan los cargadores ese día.
  scenarios: {
    nominal:  { label: "Ideal (potencia de la app)" },
    realista: { label: "Realista (lo que reportan los conductores)" },
    malo:     { label: "Mal día (señal caída, fila, calor)" }
  },

  // km desde la casa en Medellín (ruta nueva: Barbosa, Cisneros, Remedios, Segovia, Zaragoza, Caucasia).
  nodes: {
    casa:        { short: "Casa", name: "Casa (Medellín)",                 km: 0,   chargers: [] },
    popalito:    { short: "Popalito", name: "Popalito (Barbosa)",              km: 60,  chargers: ["popalito"] },
    corredor:    { short: "Corredor", name: "Corredor Remedios–Segovia",       km: 210, chargers: ["hipotesis"], hypothetical: true },
    fatima:      { short: "Fátima", name: "Fátima (La Apartada)",            km: 355, chargers: ["fatima"] },
    planetarica: { short: "P. Rica", name: "Planeta Rica",                    km: 405, chargers: ["hipotesis"], hypothetical: true },
    monteria:    { short: "Montería", name: "Montería",                        km: 458, chargers: ["castellana", "places"] },
    sincelejo:   { short: "Sincelejo", name: "Sincelejo",                       km: 511, chargers: ["doilgas"] },
    covenas:     { short: "Coveñas", name: "Coveñas (cabaña)",                km: 548, chargers: [] }
  },

  // Rutas = secuencia de nodos (sentido ida). El regreso es la misma secuencia al revés.
  routes: {
    monteria:  { label: "Vía Montería (sin Sincelejo)",
                 nodes: ["casa", "popalito", "corredor", "fatima", "planetarica", "monteria", "covenas"] },
    sincelejo: { label: "Vía Sincelejo (solo comparar)",
                 nodes: ["casa", "popalito", "corredor", "fatima", "sincelejo", "covenas"] }
  },

  // Tramos (sentido ida): km, Wh/km base, y factor de consumo al regreso (subida/viento).
  legs: {
    "casa>popalito":        { km: 60,  wh: 200, ret: 1.00 },
    "popalito>corredor":    { km: 150, wh: 140, ret: 1.15 },
    "corredor>fatima":      { km: 145, wh: 140, ret: 1.15 },
    "fatima>planetarica":   { km: 50,  wh: 155, ret: 1.10 },
    "planetarica>monteria": { km: 53,  wh: 155, ret: 1.10 },
    "monteria>covenas":     { km: 90,  wh: 170, ret: 1.00 },
    "fatima>sincelejo":     { km: 156, wh: 155, ret: 1.00 },
    "sincelejo>covenas":    { km: 58,  wh: 150, ret: 1.00 }
  },

  // kW efectivos por escenario y minutos extra por parada (enchufar, app, pago, señal).
  chargers: {
    popalito: {
      name: "Terpel Voltex Popalito", place: "Barbosa, Antioquia", connector: "CCS2 (llevar adaptador CCS1 por si acaso)",
      kw: { nominal: 40, realista: 35, malo: 12 }, overheadMin: { nominal: 8, realista: 10, malo: 20 },
      status: "ok", statusText: "Confirmado por varios",
      notes: "Primera parada de casi todos los reportes: cargan a 94–100% y siguen. Un conductor midió 40 kW al subir de 21% a 70%. Otro, en un día malo, solo 10 kW entre 87% y 99%: cerca del 100% la potencia cae, así que cargar de 80% a 100% es lento."
    },
    fatima: {
      name: "Terpel Voltex Fátima", place: "La Apartada, ≈18 km después de Caucasia hacia Planeta Rica (en otros mensajes aparece como 'Caucasia')",
      connector: "CCS1 y CCS2",
      kw: { nominal: 40, realista: 25, malo: 10 }, overheadMin: { nominal: 8, realista: 12, malo: 30 },
      status: "warn", statusText: "Intermitente",
      notes: "La app dice 40 kW. Cuatro reportes dan 20–22 kW (uno a las 13:30 con 40 °C) y dos del 5/ago dieron 37 y 45 kW, así que varía mucho: planea ~25 kW. La señal 4G se cae y corta la sesión (10/oct: solo subieron a 80%); hay que tener la app de Terpel y no alejar el celular del carro. Hubo un día fuera de servicio (23/ago). Es el único cargador rápido en los ~300 km Popalito–Montería."
    },
    castellana: {
      name: "MubOn / Voltia Plaza La Castellana", place: "Montería (centro comercial)", connector: "CCS2 (verificar en la app MubOn)",
      kw: { nominal: 60, realista: 60, malo: 30 }, overheadMin: { nominal: 8, realista: 10, malo: 20 },
      status: "ok", statusText: "Nuevo · 3 reportes de uso",
      notes: "Dos conductores cargaron aquí a 90% (19/ago) y a 100% (22/nov, de regreso). Según el grupo: 60 kW si estás solo, baja a 30 kW si llega otro carro (2 puntos). Centro comercial: se puede comer mientras carga. Es la parada que mejor funciona entre Fátima y la costa."
    },
    places: {
      name: "Places Mall (MubOn AC)", place: "Montería (centro comercial)", connector: "Tipo 2 · AC",
      kw: { nominal: 11, realista: 11, malo: 7 }, overheadMin: { nominal: 8, realista: 10, malo: 15 },
      status: "warn", statusText: "Lento (11 kW)",
      notes: "Reportado como cargador nuevo que se controla con la app MubOn. Solo sirve para dejar el carro cargando varias horas, no para una parada de ruta."
    },
    doilgas: {
      name: "Terpel Voltex Doilgas", place: "Sincelejo", connector: "CCS1 y CCS2",
      kw: { nominal: 40, realista: 40, malo: 20 }, overheadMin: { nominal: 8, realista: 12, malo: 25 },
      status: "warn", statusText: "Funciona, 1 falla de conector",
      notes: "Varios reportes de carga normal a 40 kW (12/jul, 13/sep, 4/oct). En un caso (29/jun) el CCS2 no conectó y hubo que usar convertidor CCS1."
    },
    hipotesis: {
      name: "Punto por verificar (hotel / centro con cargador)", place: "HIPÓTESIS: no hay cargador confirmado aquí", connector: "Tipo 2 AC (hipótesis)",
      kw: { nominal: 11, realista: 11, malo: 7 }, overheadMin: { nominal: 10, realista: 10, malo: 20 },
      status: "unknown", statusText: "Sin verificar",
      notes: "Sirve para simular qué pasaría SI se encuentra un cargador (hotel, finca, restaurante). La potencia es editable en el simulador. No lo cuentes como plan hasta confirmarlo."
    }
  },

  // Escenarios predefinidos. stops: { nodo: { charge: true, target: %, charger?: id } }
  presets: [
    { id: "A", label: "A · Tu plan: Popalito → Fátima → Coveñas", dir: "ida", route: "monteria", startSoc: 97, style: "normal",
      stops: { popalito: { target: 100 }, fatima: { target: 90 } } },
    { id: "B", label: "B · Fátima corto + MubOn rápido en Montería", dir: "ida", route: "monteria", startSoc: 97, style: "normal",
      stops: { popalito: { target: 100 }, fatima: { target: 70 }, monteria: { target: 85, charger: "castellana" } } },
    { id: "C", label: "C · Saltar Fátima (Eco directo a Montería)", dir: "ida", route: "monteria", startSoc: 97, style: "eco",
      stops: { popalito: { target: 100 }, monteria: { target: 80, charger: "castellana" } } },
    { id: "D", label: "D · Plan B: Fátima falla, hotel con AC en el corredor", dir: "ida", route: "monteria", startSoc: 97, style: "eco",
      stops: { popalito: { target: 100 }, corredor: { target: 80 }, monteria: { target: 80, charger: "castellana" } } },
    { id: "E", label: "E · Vía Sincelejo (comparar)", dir: "ida", route: "sincelejo", startSoc: 97, style: "normal",
      stops: { popalito: { target: 100 }, fatima: { target: 90 } } },
    { id: "R1", label: "R1 · Regreso: MubOn 100% → Fátima 100% → Popalito", dir: "regreso", route: "monteria", startSoc: 100, style: "normal",
      stops: { monteria: { target: 100, charger: "castellana" }, fatima: { target: 100 }, popalito: { target: 45 } } },
    { id: "R2", label: "R2 · Regreso Eco + parada extra en el corredor", dir: "regreso", route: "monteria", startSoc: 100, style: "eco",
      stops: { monteria: { target: 90, charger: "castellana" }, fatima: { target: 100 }, corredor: { target: 70 }, popalito: { target: 50 } } },
    { id: "R3", label: "R3 · Regreso vía Sincelejo (comparar)", dir: "regreso", route: "sincelejo", startSoc: 100, style: "normal",
      stops: { sincelejo: { target: 90 }, fatima: { target: 100 }, popalito: { target: 55 } } }
  ],

  // Reportes reales de los grupos, sin nombres. SoC = % de batería.
  reports: [
    { date: "22–23/nov", car: "AWD", route: "Medellín ⇄ Rincón del Mar (Coveñas)",
      text: "Ida: cargó en Fátima a 80% y llegó con ~30%. Regreso, más cauto: salió de Rincón al 100%, cargó a 100% en MubOn Montería (60 kW) y a 100% en Fátima, llegó a Popalito con 10% y le puso 10% más. Fue a 130–140 km/h. Dice que a 80–90 km/h se llega a Medellín desde Montería. En Rincón cargó a 220 V en la casa de unos amigos (enchufe del fogón)." },
    { date: "5/ago", car: "—", route: "Cartagena ⇄ Medellín (ida y vuelta)",
      text: "Norte: Cartagena 97% → Fátima 36%, carga a 86% (45 kW) → Popalito 21%, carga a 70% (40 kW) → Medellín 55%. Sur: Medellín 96% → Popalito 87%, carga a 99% (solo 10 kW) → Fátima 46%, carga a 85% (37 kW) → Cartagena 26%." },
    { date: "29/jun", car: "AWD LR", route: "Medellín → Barranquilla (763 km)",
      text: "Cargó en Medellín al 99%, llegó a Fátima con 30% y cargó a 60% (el cargador dio 20 kW a las 13:30 con 40 °C), llegó a Sincelejo con 23% y cargó a 81%, y llegó a Puerto Colombia con 27%. En Doilgas el CCS2 no conectó y necesitó convertidor." },
    { date: "13/jul", car: "RWD", route: "Rionegro → Popalito → Montería",
      text: "Salió de Rionegro con 73% y llegó a Popalito con 63%. Cargó a 100% y llegó a Montería con 14%, sin otra parada: es el dato RWD más cercano a tu viaje (~398 km, 86% de batería)." },
    { date: "25/jul", car: "RWD", route: "Medellín → Fátima → Medellín",
      text: "Cargó en Popalito al 100% y llegó con 35% a Fátima. Fátima semirrápido: 2 h o más a ~22 kW. De regreso llegó a Barbosa con 5%." },
    { date: "12/jul", car: "—", route: "Rionegro → Barranquilla",
      text: "Rionegro 94% → Fátima 18%; carga a 60% → Sincelejo 15%; carga a 100% → Barranquilla 30%. Fátima→Sincelejo: 156 km." },
    { date: "13/sep", car: "AWD", route: "Rionegro → Barranquilla",
      text: "Rionegro 95% → Fátima 40%; carga a 80% → Sincelejo 50%; carga a 80% (Doilgas) → Barranquilla 45%. Salió 6:00, llegó 22:30." },
    { date: "4/oct", car: "AWD", route: "Envigado → Cartagena",
      text: "Envigado 92% → Fátima 26%; carga a 95% → Sincelejo 45%; carga a 95% → Cartagena 45%. 3 personas, A/C a 22 °C todo el viaje." },
    { date: "10/oct", car: "AWD", route: "Cartagena → Envigado (regreso)",
      text: "Sincelejo cargaron 65% → 100%; llegaron a Fátima con 65% pero la señal se cayó y solo subieron a 80%. Aun así llegaron a Envigado." },
    { date: "8/oct", car: "RWD", route: "Medellín → Rincón del Mar (Coveñas)",
      text: "Medellín 100% → Popalito 78%, carga a 97% → Fátima 22%, carga a 90% → Rincón del Mar 22%. Es el reporte más parecido a tu viaje." },
    { date: "19/ago", car: "—", route: "Medellín → Cartagena (por Montería)",
      text: "Barbosa 70%, carga a 90% → Caucasia 24% → Fátima 20%, carga a 90% → Montería 77%; carga en MubOn a 90% → Bocagrande 21%. Un desvío les sumó ~1 h cerca de Caucasia." },
    { date: "29/jun", car: "—", route: "Medellín → Sincelejo",
      text: "En Doilgas (Sincelejo) el CCS2 no conectó y necesitaron convertidor CCS1. En Fátima el cargador entregó 20 kW a las 13:30 con 40 °C." },
    { date: "24/jul", car: "—", route: "Rionegro/Popalito → Montería",
      text: "Un conductor del grupo: cargando al 100% en Popalito se llega a Montería con ~15%. Plan B si Fátima falla: contingencia en Montería (Places Mall, 11 kW)." }
  ],

  // Lo que se aprendió al cruzar los reportes (se muestra en "Viajes reales").
  lessons: [
    "Popalito 100% → Fátima gastó entre 53% y 75% de la batería; lo normal es 65–70%. Llegar con 25–35% es lo esperable.",
    "Con un Model Y RWD, Popalito 100% → Montería sin cargar en Fátima llegó con 14–15% manejando suave. Se puede, pero sin margen.",
    "El regreso gasta mucho más: de Fátima al 100% se llegó a Popalito con entre 4% y 36% según la velocidad. A 130–140 km/h casi no alcanza; a 90 km/h sobra.",
    "Fátima entrega 20–45 kW según el día. Planea ~25 kW (más de 1 h para una carga útil) y ten un plan B si falla.",
    "MubOn La Castellana (Montería, 60 kW) ya tiene dos reportes de uso y es la mejor parada del tramo final, ida y vuelta.",
    "ABRP y los bots son optimistas: Medellín → Montería sin cargar no se logra, aunque ellos digan que sobran ~25–35%."
  ],

  // Puntos para investigar. Nada de esto está confirmado.
  candidates: [
    { name: "Cabaña #2, Condominio Victoria Real", text: "Confirmar con la propietaria si hay toma 110 V / 220 V. Define si el regreso es tranquilo. Pide fotos del tablero y distancia del parqueadero." },
    { name: "Hoteles en Caucasia, Zaragoza, Segovia o Remedios", text: "Airbnb y Booking tienen filtro de 'cargador para vehículo eléctrico'. Un Tipo 2 de 7–11 kW durante una comida o noche sirve de respaldo en el tramo de ~300 km sin rápido." },
    { name: "Rincón del Mar y San Antero", text: "Un conductor cargó a 220 V en la casa de unos amigos en Balsillas (enchufe del fogón) y ofreció conseguir quién deje cargar a otros. Sin cargador público reportado ahí. Pregunta a la cabaña por una toma de 220 V; sin ella, el plan depende de Montería." },
    { name: "Planeta Rica", text: "Un viajero durmió ahí (modo centinela toda la noche) pero no hay cargador reportado. Revisar PlugShare y Electromaps antes de contar con él.", link: "https://www.plugshare.com" },
    { name: "Tolú", text: "En el chat compartieron un punto de Electromaps en Tolú (24/jul). Sin verificar, y queda del lado de Sincelejo.", link: "https://map.electromaps.com/en/p/819465" },
    { name: "Lorica · estación Urrá (Tipo 2, lenta)", text: "Mencionada para la ruta por Cereté/Lorica, en un restaurante. Sirve solo si la ruta pasa por ahí." },
    { name: "Los Manguitos (Ruta al Mar)", text: "Aparece en tu infografía como punto a confirmar. No se encontró reporte en los chats." }
  ],

  checklist: [
    "Cargar al 100% en casa o en Popalito antes de la salida larga (ABRP/Tesla recalculan desde ahí).",
    "Llevar adaptador CCS1→CCS2 / convertidor (en Doilgas el CCS2 falló una vez) y el cargador portátil para toma normal.",
    "Instalar y registrar: app Terpel, MubOn, PlugShare, Electromaps y ABRP. Tarjeta física de EPM por si acaso.",
    "El día anterior, preguntar en el grupo 'Viajes' si Fátima y Popalito están funcionando.",
    "Instalar la app de Terpel antes de salir y no alejar el celular del carro en Fátima: la señal se cae y corta la sesión.",
    "No confiar en ABRP ni en los bots del grupo para el tramo Popalito–Montería: dan ~25 puntos de batería de más. Mandan los reportes reales.",
    "Fin de año = temporada alta: filas en los cargadores. Salir temprano y tener el plan B definido.",
    "Confirmar con la propietaria si hay toma en la cabaña, y de cuántos amperios.",
    "En el regreso, bajar la velocidad: Fátima→Popalito consume ~15% más que la ida, y a 130–140 km/h se llegó con solo 10%.",
    "En Fátima, no confiar en los 40 kW de la app: planear 20 kW (≈2 h) y llevar comida y entretenimiento.",
    "Montar ruta en ABRP con carga real (no la de ficha) y comparar contra la pantalla del Tesla.",
    "Después del viaje, registrar el viaje en teslacolombiamotorsclub.com/tecnico/viajes."
  ],

  sources: [
    "Grupo de WhatsApp 'Viajes' y 'Viajes y Rutas' (Tesla Colombia Motors Club), mayo–octubre 2026.",
    "Ruta ABRP de Andrés: 457,6 km Poblado → Montería sin cargar, 122 Wh/km, 99% → 25%.",
    "Reportes nuevos del grupo 'Viajes' hasta el 23/nov/2026 (Rincón del Mar, Cartagena, Barranquilla).",
    "Distancias por carretera (rome2rio): Caucasia–La Apartada 18 km, La Apartada–Montería 103 km, Montería–Coveñas ≈ 90 km, Caucasia–Planeta Rica 68 km."
  ]
};
