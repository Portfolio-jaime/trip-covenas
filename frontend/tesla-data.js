// Datos de la ruta Medellín → Coveñas en Tesla Model Y RWD.
//
// Fuentes: reportes reales de conductores en los grupos de WhatsApp "Viajes" y
// "Viajes y Rutas" (Tesla Colombia Motors Club, mayo–octubre 2026), los
// números de la propia ruta de Andrés en ABRP (457,6 km Poblado→Montería) y
// distancias por carretera de rome2rio. Todo lo que no esté confirmado por
// conductores está marcado como "hipotesis" o "sin verificar".
//
// Los consumos (Wh/km) están calibrados contra los reportes:
//   Popalito 100% → Fátima llegó con 22–35%  → ~150 Wh/km en ese tramo.
//   Fátima → Popalito (regreso) llegó con 5% → factor de subida ~1,27.
//   Popalito 100% → Montería ≈ 15% (modo suave) → coincide con estilo "Eco".
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
    "popalito>corredor":    { km: 150, wh: 150, ret: 1.27 },
    "corredor>fatima":      { km: 145, wh: 150, ret: 1.27 },
    "fatima>planetarica":   { km: 50,  wh: 140, ret: 1.10 },
    "planetarica>monteria": { km: 53,  wh: 140, ret: 1.10 },
    "monteria>covenas":     { km: 90,  wh: 150, ret: 1.00 },
    "fatima>sincelejo":     { km: 156, wh: 140, ret: 1.00 },
    "sincelejo>covenas":    { km: 58,  wh: 140, ret: 1.00 }
  },

  // kW efectivos por escenario y minutos extra por parada (enchufar, app, pago, señal).
  chargers: {
    popalito: {
      name: "Terpel Voltex Popalito", place: "Barbosa, Antioquia", connector: "CCS2 (llevar adaptador CCS1 por si acaso)",
      kw: { nominal: 40, realista: 35, malo: 20 }, overheadMin: { nominal: 8, realista: 10, malo: 20 },
      status: "ok", statusText: "Confirmado por varios",
      notes: "Primera parada de casi todos los reportes: cargan a 94–100% y siguen. La potencia exacta no aparece en los reportes; se asumió igual a los otros Voltex."
    },
    fatima: {
      name: "Terpel Voltex Fátima", place: "La Apartada, ≈18 km después de Caucasia hacia Planeta Rica (en otros mensajes aparece como 'Caucasia')",
      connector: "CCS1 y CCS2",
      kw: { nominal: 40, realista: 20, malo: 10 }, overheadMin: { nominal: 8, realista: 12, malo: 30 },
      status: "warn", statusText: "Intermitente",
      notes: "La app dice 40 kW pero cuatro conductores reportan 20–22 kW (uno a las 13:30 con 40 °C). Una carga de ~2 h es lo normal. Hay reportes de señal 4G caída que corta la sesión (10/oct: solo pudieron subir a 80%) y de cargador fuera de servicio (23/ago). Es el único cargador rápido en los ~300 km Popalito–Montería."
    },
    castellana: {
      name: "MubOn / Voltia Plaza La Castellana", place: "Montería (centro comercial)", connector: "CCS2 (verificar en la app MubOn)",
      kw: { nominal: 60, realista: 60, malo: 30 }, overheadMin: { nominal: 8, realista: 10, malo: 20 },
      status: "ok", statusText: "Nuevo · 1 reporte de uso",
      notes: "Un viaje (19/ago) cargó aquí hasta 90% rumbo a Cartagena. Según el grupo: 60 kW si estás solo, baja a 30 kW si llega otro carro (2 puntos). Centro comercial: se puede comer mientras carga."
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
    { id: "R1", label: "R1 · Regreso: MubOn → Fátima 100% → Popalito", dir: "regreso", route: "monteria", startSoc: 100, style: "normal",
      stops: { monteria: { target: 90, charger: "castellana" }, fatima: { target: 100 }, popalito: { target: 55 } } },
    { id: "R2", label: "R2 · Regreso Eco + parada extra en el corredor", dir: "regreso", route: "monteria", startSoc: 100, style: "eco",
      stops: { monteria: { target: 90, charger: "castellana" }, fatima: { target: 100 }, corredor: { target: 70 }, popalito: { target: 50 } } },
    { id: "R3", label: "R3 · Regreso vía Sincelejo (comparar)", dir: "regreso", route: "sincelejo", startSoc: 100, style: "normal",
      stops: { sincelejo: { target: 90 }, fatima: { target: 100 }, popalito: { target: 55 } } }
  ],

  // Reportes reales de los grupos, sin nombres. SoC = % de batería.
  reports: [
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

  // Puntos para investigar. Nada de esto está confirmado.
  candidates: [
    { name: "Cabaña #2, Condominio Victoria Real", text: "Confirmar con la propietaria si hay toma 110 V / 220 V. Define si el regreso es tranquilo. Pide fotos del tablero y distancia del parqueadero." },
    { name: "Hoteles en Caucasia, Zaragoza, Segovia o Remedios", text: "Airbnb y Booking tienen filtro de 'cargador para vehículo eléctrico'. Un Tipo 2 de 7–11 kW durante una comida o noche sirve de respaldo en el tramo de ~300 km sin rápido." },
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
    "Fin de año = temporada alta: filas en los cargadores. Salir temprano y tener el plan B definido.",
    "Confirmar con la propietaria si hay toma en la cabaña, y de cuántos amperios.",
    "En el regreso, bajar la velocidad: Fátima→Popalito consume ~27% más que la ida.",
    "En Fátima, no confiar en los 40 kW de la app: planear 20 kW (≈2 h) y llevar comida y entretenimiento.",
    "Montar ruta en ABRP con carga real (no la de ficha) y comparar contra la pantalla del Tesla.",
    "Después del viaje, registrar el viaje en teslacolombiamotorsclub.com/tecnico/viajes."
  ],

  sources: [
    "Grupo de WhatsApp 'Viajes' y 'Viajes y Rutas' (Tesla Colombia Motors Club), mayo–octubre 2026.",
    "Ruta ABRP de Andrés: 457,6 km Poblado → Montería sin cargar, 122 Wh/km, 99% → 25%.",
    "Distancias por carretera (rome2rio): Caucasia–La Apartada 18 km, La Apartada–Montería 103 km, Montería–Coveñas ≈ 90 km, Caucasia–Planeta Rica 68 km."
  ]
};
