// Pestaña "Tesla": simulador de la ruta Medellín ⇄ Coveñas en Model Y RWD.
// Todo corre en el navegador (sin API): datos en tesla-data.js, lógica aquí.
// El motor (simulate) es puro y no toca el DOM; la UI solo lo llama.
(function () {
  "use strict";

  var D = window.TESLA_DATA;
  if (!D) return;

  // ====================================================================
  // Motor de simulación
  // ====================================================================

  // Potencia máxima que acepta el carro según el % de batería (curva
  // simplificada de un LFP: rápido hasta ~40%, baja desde 80%).
  var VEHICLE_CURVE = [[0, 170], [40, 170], [80, 100], [90, 60], [100, 25]];
  var CHARGE_EFFICIENCY = 0.92; // pérdidas cargador→batería
  var STEP_PCT = 0.5;

  function vehicleKw(soc) {
    for (var i = 1; i < VEHICLE_CURVE.length; i++) {
      var a = VEHICLE_CURVE[i - 1], b = VEHICLE_CURVE[i];
      if (soc <= b[0]) return a[1] + (b[1] - a[1]) * ((soc - a[0]) / (b[0] - a[0]));
    }
    return VEHICLE_CURVE[VEHICLE_CURVE.length - 1][1];
  }

  function chargeSession(fromSoc, toSoc, stationKw, usableKwh) {
    var minutes = 0, kwh = 0;
    for (var s = fromSoc; s < toSoc; s += STEP_PCT) {
      var ds = Math.min(STEP_PCT, toSoc - s);
      var power = Math.min(stationKw, vehicleKw(s + ds / 2));
      var e = usableKwh * ds / 100;
      kwh += e;
      minutes += (e / power) * 60;
    }
    return { minutes: minutes, kwh: kwh };
  }

  function routeSequence(routeId, dir) {
    var seq = D.routes[routeId].nodes.slice();
    return dir === "regreso" ? seq.reverse() : seq;
  }

  function legBetween(from, to, dir) {
    var key = dir === "regreso" ? to + ">" + from : from + ">" + to;
    var leg = D.legs[key];
    return { km: leg.km, wh: leg.wh * (dir === "regreso" ? leg.ret : 1) };
  }

  function chargerKw(charger, cfg) {
    if (charger === D.chargers.hipotesis) return cfg.customKw;
    return charger.kw[cfg.scenario];
  }

  function simulate(cfg) {
    var style = D.styles[cfg.style], load = D.loads[cfg.load];
    var seq = routeSequence(cfg.route, cfg.dir);
    var soc = cfg.startSoc;
    var res = {
      seq: seq, steps: [], points: [{ km: 0, soc: soc }], ok: true, failAt: null,
      km: 0, driveMin: 0, chargeMin: 0, kwhGrid: 0, cost: 0, minSoc: soc, arriveSoc: soc
    };
    var kmCursor = 0;

    for (var i = 0; i < seq.length; i++) {
      var id = seq[i];
      if (i > 0) {
        var leg = legBetween(seq[i - 1], id, cfg.dir);
        var whkm = leg.wh * style.mult * load.mult;
        var kwh = leg.km * whkm / 1000;
        var drop = kwh / cfg.usable * 100;
        var socIn = soc;
        soc -= drop;
        kmCursor += leg.km;
        res.km += leg.km;
        var driveMin = leg.km / style.avgKmh * 60;
        res.driveMin += driveMin;
        res.steps.push({ type: "leg", from: seq[i - 1], to: id, km: leg.km, whkm: whkm, kwh: kwh,
          drop: drop, socIn: socIn, socOut: soc, min: driveMin });
        res.points.push({ km: kmCursor, soc: Math.max(soc, 0) });
        if (soc < res.minSoc) res.minSoc = soc;
        if (soc < 0) {
          res.ok = false;
          res.failAt = { from: seq[i - 1], to: id };
          break;
        }
      }
      var sc = cfg.stops[id];
      var isLast = i === seq.length - 1;
      if (!isLast && i > 0 && sc && sc.charge && sc.target > soc) {
        var node = D.nodes[id];
        var chargerId = sc.charger || node.chargers[0];
        var charger = D.chargers[chargerId];
        if (charger) {
          var kw = chargerKw(charger, cfg);
          var sess = chargeSession(soc, sc.target, kw, cfg.usable);
          var overhead = charger.overheadMin[cfg.scenario];
          var grid = sess.kwh / CHARGE_EFFICIENCY;
          var stepCost = grid * cfg.price;
          res.chargeMin += sess.minutes + overhead;
          res.kwhGrid += grid;
          res.cost += stepCost;
          res.steps.push({ type: "stop", node: id, chargerId: chargerId, socArr: soc, socDep: sc.target,
            kw: kw, min: sess.minutes + overhead, kwh: sess.kwh, cost: stepCost });
          soc = sc.target;
          res.points.push({ km: kmCursor, soc: soc });
        }
      }
    }
    res.arriveSoc = soc;
    res.totalMin = res.driveMin + res.chargeMin;
    res.verdict = !res.ok ? "fail" : (res.minSoc < cfg.reserve ? "tight" : "ok");
    annotateNeeded(res, cfg.reserve);
    return res;
  }

  // Para cada parada: % mínimo con el que hay que salir para llegar a la
  // siguiente parada (o al destino) sin bajar de la reserva.
  function annotateNeeded(res, reserve) {
    for (var i = 0; i < res.steps.length; i++) {
      if (res.steps[i].type !== "stop") continue;
      var need = reserve;
      for (var j = i + 1; j < res.steps.length && res.steps[j].type === "leg"; j++) {
        need += res.steps[j].drop;
      }
      res.steps[i].needed = need;
    }
  }

  // ====================================================================
  // Utilidades de formato
  // ====================================================================

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pct(n) { return Math.round(n) + "%"; }
  function money(n) { return "$" + (Math.round(n / 1000) * 1000).toLocaleString("es-CO"); }
  function dur(min) {
    var m = Math.round(min), h = Math.floor(m / 60), r = m % 60;
    return h ? h + " h " + (r < 10 ? "0" : "") + r + " min" : r + " min";
  }
  function clock(totalMin) {
    var m = Math.round(totalMin), day = Math.floor(m / 1440);
    m = ((m % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), r = m % 60;
    return (h < 10 ? "0" : "") + h + ":" + (r < 10 ? "0" : "") + r + (day ? " (+" + day + " d)" : "");
  }
  function parseClock(v) {
    var p = String(v || "05:30").split(":");
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }
  function nodeName(id) { return D.nodes[id].name; }
  function verdictBadge(v, reserve) {
    if (v === "ok") return '<span class="tz-badge ok">Llega con margen</span>';
    if (v === "tight") return '<span class="tz-badge warn">Justo (baja de ' + reserve + '%)</span>';
    return '<span class="tz-badge bad">No llega</span>';
  }

  // ====================================================================
  // Estado
  // ====================================================================

  var state = {
    dir: "ida", route: "monteria", startSoc: 97, reserve: 10,
    style: "normal", load: "medio", scenario: "realista",
    usable: D.vehicle.usableKwh, price: 1800, customKw: 11, depart: "05:30",
    stops: {}, preset: "A"
  };

  function cfgOf(s) {
    return { dir: s.dir, route: s.route, startSoc: s.startSoc, reserve: s.reserve, style: s.style,
      load: s.load, scenario: s.scenario, usable: s.usable, price: s.price, customKw: s.customKw,
      stops: s.stops };
  }

  function applyPreset(id) {
    var p = D.presets.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    state.preset = id;
    state.dir = p.dir; state.route = p.route; state.startSoc = p.startSoc; state.style = p.style;
    state.stops = {};
    Object.keys(p.stops).forEach(function (n) {
      state.stops[n] = { charge: true, target: p.stops[n].target, charger: p.stops[n].charger };
    });
  }

  // ====================================================================
  // Gráfica SoC vs km
  // ====================================================================

  function chartSvg(res, cfg) {
    var W = 720, H = 240, L = 38, R = 14, T = 14, B = 44;
    var maxKm = res.points[res.points.length - 1].km || 1;
    function x(km) { return L + (km / maxKm) * (W - L - R); }
    function y(s) { return T + (1 - Math.max(0, Math.min(100, s)) / 100) * (H - T - B); }
    var out = '<svg class="tz-chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Batería a lo largo de la ruta">';
    out += '<rect x="' + L + '" y="' + y(cfg.reserve) + '" width="' + (W - L - R) + '" height="' + (y(0) - y(cfg.reserve)) +
      '" class="tz-danger"/>';
    [0, 25, 50, 75, 100].forEach(function (g) {
      out += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(g) + '" y2="' + y(g) + '" class="tz-grid"/>' +
        '<text x="' + (L - 6) + '" y="' + (y(g) + 4) + '" text-anchor="end" class="tz-axis">' + g + "%</text>";
    });
    var d = res.points.map(function (p, i) { return (i ? "L" : "M") + x(p.km).toFixed(1) + " " + y(p.soc).toFixed(1); }).join(" ");
    out += '<path d="' + d + '" class="tz-line"/>';
    // marcadores de nodos con su etiqueta
    var km = 0;
    res.seq.forEach(function (id, i) {
      if (i > 0) {
        var st = res.steps.filter(function (s) { return s.type === "leg" && s.to === id; })[0];
        if (!st) return;
        km += st.km;
      }
      var cx = x(km);
      var charged = res.steps.some(function (s) { return s.type === "stop" && s.node === id; });
      out += '<circle cx="' + cx + '" cy="' + (H - B + 8) + '" r="4" class="' + (charged ? "tz-dot charge" : "tz-dot") + '"/>' +
        '<text x="' + cx + '" y="' + (H - B + 26) + '" text-anchor="' + (i === 0 ? "start" : (i === res.seq.length - 1 ? "end" : "middle")) +
        '" class="tz-axis">' + esc(D.nodes[id].short) + "</text>";
    });
    out += "</svg>";
    return out;
  }

  // ====================================================================
  // Render de resultados
  // ====================================================================

  function el(id) { return document.getElementById(id); }

  function renderResults() {
    var cfg = cfgOf(state);
    var res = simulate(cfg);
    var depart = parseClock(state.depart);

    var kpis = [
      { k: "Llegada", v: res.ok ? pct(res.arriveSoc) : "—", sub: res.ok ? "batería al destino" : "se agota antes" },
      { k: "Tiempo total", v: dur(res.totalMin), sub: "manejo " + dur(res.driveMin) },
      { k: "Cargando", v: dur(res.chargeMin), sub: Math.round(res.kwhGrid) + " kWh de la red" },
      { k: "Costo carga", v: money(res.cost), sub: "a $" + Math.round(state.price).toLocaleString("es-CO") + "/kWh" },
      { k: "Hora de llegada", v: res.ok ? clock(depart + res.totalMin) : "—", sub: "salida " + state.depart }
    ];
    el("tz-kpis").innerHTML = kpis.map(function (c) {
      return '<div class="stat-card"><p class="k">' + c.k + '</p><p class="v">' + c.v + '</p><p class="tz-sub">' + c.sub + "</p></div>";
    }).join("");

    el("tz-verdict").innerHTML = verdictBadge(res.verdict, state.reserve) +
      ' <span class="tz-muted">Mínimo en ruta: <b>' + pct(Math.max(res.minSoc, 0)) + "</b> · " + Math.round(res.km) + " km</span>";

    el("tz-chart").innerHTML = chartSvg(res, cfg);
    el("tz-alerts").innerHTML = alertsHtml(res, cfg);
    el("tz-timeline").innerHTML = timelineHtml(res, depart);
    el("tz-failmatrix").innerHTML = failMatrixHtml(cfg);
    el("tz-compare").innerHTML = compareHtml();
  }

  function alertsHtml(res, cfg) {
    var items = [];
    if (!res.ok) {
      items.push(['bad', "No llega: la batería se agota entre <b>" + esc(nodeName(res.failAt.from)) + "</b> y <b>" +
        esc(nodeName(res.failAt.to)) + "</b>. Hace falta otra carga antes o salir con más batería."]);
    }
    res.steps.forEach(function (s) {
      if (s.type === "leg" && s.socOut >= 0 && s.socOut < cfg.reserve) {
        items.push(['warn', "Llegas a " + esc(nodeName(s.to)) + " con solo " + pct(s.socOut) + ", por debajo de tu reserva (" + cfg.reserve + "%)."]);
      }
      if (s.type === "stop") {
        if (s.min > 90) items.push(['warn', "Parada larga en " + esc(nodeName(s.node)) + ": " + dur(s.min) + " (" + Math.round(s.kw) + " kW efectivos)."]);
        if (s.socDep < s.needed - 0.5) {
          items.push(['warn', "Saliendo de " + esc(nodeName(s.node)) + " con " + pct(s.socDep) + " no cubres el siguiente tramo con reserva; necesitas ≥ " + pct(s.needed) + "."]);
        }
        if (s.chargerId === "hipotesis") items.push(['info', esc(nodeName(s.node)) + ": usa un punto HIPOTÉTICO. No lo cuentes hasta confirmar que existe."]);
      }
    });
    var stopsInPlan = res.steps.filter(function (s) { return s.type === "stop"; });
    if (stopsInPlan.some(function (s) { return s.chargerId === "fatima"; }) && cfg.scenario !== "nominal") {
      items.push(['info', "Fátima rinde ~20 kW en la práctica: planea ~2 h ahí aunque la app diga 40 kW."]);
    }
    if (!items.length) items.push(['ok', "Sin alertas con estos supuestos."]);
    return items.map(function (a) { return '<li class="tz-alert ' + a[0] + '">' + a[1] + "</li>"; }).join("");
  }

  function timelineHtml(res, depart) {
    var t = depart, rows = "";
    res.steps.forEach(function (s) {
      var start = t;
      t += s.min;
      if (s.type === "leg") {
        rows += "<tr><td>" + clock(start) + "</td><td>🛣 " + esc(nodeName(s.from).split(" (")[0]) + " → " + esc(nodeName(s.to).split(" (")[0]) +
          '</td><td class="num">' + Math.round(s.km) + " km · " + Math.round(s.whkm) + " Wh/km</td><td class=\"num\">" +
          pct(s.socIn) + " → <b class=\"" + (s.socOut < 0 ? "tz-neg" : "") + "\">" + pct(Math.max(s.socOut, 0)) + "</b></td><td class=\"num\">" + dur(s.min) + "</td></tr>";
      } else {
        var ch = D.chargers[s.chargerId];
        rows += '<tr class="tz-stoprow"><td>' + clock(start) + "</td><td>⚡ " + esc(ch.name) +
          '</td><td class="num">' + Math.round(s.kw) + " kW · +" + Math.round(s.kwh) + " kWh</td><td class=\"num\">" +
          pct(s.socArr) + " → <b>" + pct(s.socDep) + '</b></td><td class="num">' + dur(s.min) + "</td></tr>";
      }
    });
    return '<div class="grid-table-wrap"><table class="grid-table"><thead><tr><th>Hora</th><th>Tramo / parada</th><th>Datos</th><th>Batería</th><th>Duración</th></tr></thead><tbody>' +
      rows + "</tbody></table></div>" + neededHtml(res);
  }

  function neededHtml(res) {
    var stops = res.steps.filter(function (s) { return s.type === "stop"; });
    if (!stops.length) return "";
    return '<p class="grid-note"><b>Mínimo para salir de cada parada</b> (con tu reserva): ' + stops.map(function (s) {
      return esc(nodeName(s.node).split(" (")[0]) + " ≥ <b>" + pct(Math.min(100, s.needed)) + "</b>" + (s.needed > 100 ? " (imposible: falta otro cargador)" : "");
    }).join(" · ") + ".</p>";
  }

  // "¿Qué pasa si falla este cargador?" — repite la simulación sin cada parada.
  function failMatrixHtml(cfg) {
    var rows = "";
    Object.keys(cfg.stops).forEach(function (id) {
      var sc = cfg.stops[id];
      if (!sc || !sc.charge) return;
      var clone = JSON.parse(JSON.stringify(cfg));
      clone.stops[id].charge = false;
      var r = simulate(clone);
      var seq = routeSequence(cfg.route, cfg.dir);
      if (seq.indexOf(id) === -1) return;
      rows += "<tr><td>Sin cargar en " + esc(nodeName(id).split(" (")[0]) + "</td><td>" + verdictBadge(r.verdict, cfg.reserve) +
        '</td><td class="num">' + (r.ok ? pct(Math.max(r.minSoc, 0)) : "se agota") + "</td></tr>";
    });
    if (!rows) return '<div class="empty-state">No hay paradas de carga activas en este plan.</div>';
    return '<div class="grid-table-wrap"><table class="grid-table"><thead><tr><th>Si te saltas…</th><th>Resultado</th><th>Mínimo en ruta</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
  }

  // Corre todos los escenarios con los supuestos globales actuales.
  function compareHtml() {
    var rows = D.presets.map(function (p) {
      var s = JSON.parse(JSON.stringify(state));
      s.dir = p.dir; s.route = p.route; s.startSoc = p.startSoc; s.style = p.style; s.stops = {};
      Object.keys(p.stops).forEach(function (n) { s.stops[n] = { charge: true, target: p.stops[n].target, charger: p.stops[n].charger }; });
      var r = simulate(cfgOf(s));
      return '<tr class="tz-clickrow" data-preset="' + p.id + '"><td>' + esc(p.label) + "</td><td>" + verdictBadge(r.verdict, state.reserve) +
        '</td><td class="num">' + (r.ok ? pct(r.arriveSoc) : "—") + '</td><td class="num">' + pct(Math.max(r.minSoc, 0)) +
        '</td><td class="num">' + dur(r.totalMin) + '</td><td class="num">' + dur(r.chargeMin) + '</td><td class="num">' + money(r.cost) + "</td></tr>";
    }).join("");
    return '<div class="grid-table-wrap"><table class="grid-table"><thead><tr><th>Escenario</th><th>Resultado</th><th>Llegada</th><th>Mínimo</th><th>Total</th><th>Cargando</th><th>Costo</th></tr></thead><tbody>' +
      rows + "</tbody></table></div>";
  }

  // ====================================================================
  // Controles
  // ====================================================================

  function stopControlsHtml() {
    var seq = routeSequence(state.route, state.dir);
    var out = "";
    seq.forEach(function (id, i) {
      var node = D.nodes[id];
      if (i === 0 || i === seq.length - 1 || !node.chargers.length) return;
      var sc = state.stops[id] || { charge: false, target: 80 };
      var chargerId = sc.charger || node.chargers[0];
      var ch = D.chargers[chargerId];
      var opts = node.chargers.length > 1 ? '<select data-stop="' + id + '" data-field="charger">' +
        node.chargers.map(function (c) { return '<option value="' + c + '"' + (c === chargerId ? " selected" : "") + ">" + esc(D.chargers[c].name) + "</option>"; }).join("") + "</select>" : "";
      out += '<div class="tz-stop' + (node.hypothetical ? " hyp" : "") + '">' +
        '<label class="tz-check"><input type="checkbox" data-stop="' + id + '" data-field="charge"' + (sc.charge ? " checked" : "") + "> " +
        "<b>" + esc(node.name) + "</b>" + (node.hypothetical ? ' <span class="tz-badge info">hipótesis</span>' : "") + "</label>" +
        '<div class="tz-stop-body"><span class="tz-muted">' + esc(ch.name) + " · " + esc(ch.statusText) + "</span>" + opts +
        '<label class="tz-range">Cargar hasta <b id="tz-t-' + id + '">' + Math.round(sc.target) + '%</b>' +
        '<input type="range" min="30" max="100" step="5" value="' + sc.target + '" data-stop="' + id + '" data-field="target"></label></div></div>';
    });
    return out || '<div class="empty-state">Esta ruta no tiene paradas intermedias configurables.</div>';
  }

  function selectHtml(id, map, current) {
    return '<select id="' + id + '">' + Object.keys(map).map(function (k) {
      return '<option value="' + k + '"' + (k === current ? " selected" : "") + ">" + esc(map[k].label) + "</option>";
    }).join("") + "</select>";
  }

  function renderControls() {
    el("tz-presets").innerHTML = D.presets.map(function (p) {
      return '<button type="button" class="tz-chip' + (p.id === state.preset ? " active" : "") + '" data-preset="' + p.id + '">' + esc(p.label) + "</button>";
    }).join("");
    el("tz-stops").innerHTML = stopControlsHtml();
    el("tz-dir-ida").setAttribute("aria-pressed", state.dir === "ida");
    el("tz-dir-regreso").setAttribute("aria-pressed", state.dir === "regreso");
    el("tz-route").value = state.route;
    el("tz-start").value = state.startSoc;
    el("tz-start-v").textContent = Math.round(state.startSoc) + "%";
    el("tz-style").value = state.style;
  }

  function onChange(e) {
    var t = e.target;
    var stopId = t.getAttribute && t.getAttribute("data-stop");
    if (stopId) {
      var sc = state.stops[stopId] || (state.stops[stopId] = { charge: false, target: 80 });
      var field = t.getAttribute("data-field");
      if (field === "charge") sc.charge = t.checked;
      else if (field === "target") { sc.target = parseInt(t.value, 10); el("tz-t-" + stopId).textContent = sc.target + "%"; }
      else if (field === "charger") sc.charger = t.value;
      state.preset = "";
      if (field === "charger") { renderControls(); }
      renderResults();
      return;
    }
    switch (t.id) {
      case "tz-route": state.route = t.value; state.preset = ""; renderControls(); break;
      case "tz-start": state.startSoc = parseInt(t.value, 10); el("tz-start-v").textContent = state.startSoc + "%"; break;
      case "tz-reserve": state.reserve = parseInt(t.value, 10); el("tz-reserve-v").textContent = state.reserve + "%"; break;
      case "tz-style": state.style = t.value; break;
      case "tz-load": state.load = t.value; break;
      case "tz-scenario": state.scenario = t.value; break;
      case "tz-depart": state.depart = t.value; break;
      case "tz-usable": state.usable = Math.max(40, parseFloat(t.value) || D.vehicle.usableKwh); break;
      case "tz-price": state.price = Math.max(0, parseFloat(t.value) || 0); break;
      case "tz-customkw": state.customKw = Math.max(1, parseFloat(t.value) || 11); break;
      default: return;
    }
    renderResults();
  }

  function onClick(e) {
    var t = e.target.closest ? e.target.closest("[data-preset],[data-dir]") : null;
    if (!t) return;
    if (t.hasAttribute("data-preset")) {
      applyPreset(t.getAttribute("data-preset"));
    } else {
      state.dir = t.getAttribute("data-dir");
      state.preset = "";
      // Al cambiar de sentido, las paradas se conservan (mismos nodos).
    }
    renderControls();
    renderResults();
  }

  // ====================================================================
  // Calculadora: carga lenta en la cabaña
  // ====================================================================

  var OUTLETS = {
    "110": { label: "Toma normal 110 V (cargador portátil, ~1,3 kW)", kw: 1.3 },
    "220": { label: "Toma 220 V (~3,5 kW)", kw: 3.5 },
    "220b": { label: "Toma 220 V reforzada / Wall Connector (~7 kW)", kw: 7 }
  };

  function cabanaHtml() {
    return '<div class="tz-grid2">' +
      '<label>Toma disponible<select id="tz-cab-outlet">' + Object.keys(OUTLETS).map(function (k) {
        return '<option value="' + k + '">' + esc(OUTLETS[k].label) + "</option>";
      }).join("") + "</select></label>" +
      '<label>Horas conectado<input id="tz-cab-hours" type="number" min="1" max="72" value="10"></label>' +
      '<label>Batería al llegar (%)<input id="tz-cab-from" type="number" min="0" max="100" value="45"></label>' +
      '<label>Precio kWh en la cabaña<input id="tz-cab-price" type="number" min="0" step="50" value="900"></label></div>' +
      '<div id="tz-cab-out" class="notes" style="margin-top:12px"></div>';
  }

  function updateCabana() {
    var o = OUTLETS[el("tz-cab-outlet").value];
    var hours = parseFloat(el("tz-cab-hours").value) || 0;
    var from = parseFloat(el("tz-cab-from").value) || 0;
    var price = parseFloat(el("tz-cab-price").value) || 0;
    var kwh = o.kw * hours * 0.9;
    var gained = kwh / state.usable * 100;
    var end = Math.min(100, from + gained);
    var hoursTo100 = (100 - from) / 100 * state.usable / (o.kw * 0.9);
    el("tz-cab-out").innerHTML = "En " + hours + " h sumas ≈ <b>" + Math.round(kwh) + " kWh</b> (+" + Math.round(gained) + "%): sales con ≈ <b>" +
      Math.round(end) + "%</b>. Para llegar a 100% desde " + Math.round(from) + "% hacen falta ≈ <b>" + dur(hoursTo100 * 60) +
      "</b>. Costo aproximado: <b>" + money(Math.min(kwh, (100 - from) / 100 * state.usable) * price) + '</b>. ' +
      '<button type="button" class="tz-chip" id="tz-cab-use">Usar ' + Math.round(end) + "% como batería de salida del regreso</button>";
    el("tz-cab-use").onclick = function () {
      state.dir = "regreso"; state.startSoc = Math.round(end); state.preset = "";
      renderControls(); renderResults();
      el("tz-sim-top").scrollIntoView({ behavior: "smooth", block: "start" });
    };
  }

  // ====================================================================
  // Secciones estáticas
  // ====================================================================

  function chargersHtml() {
    return Object.keys(D.chargers).filter(function (k) { return k !== "hipotesis"; }).map(function (k) {
      var c = D.chargers[k];
      return '<div class="b-card"><div class="b-top"><div><span class="b-name">' + esc(c.name) + '</span> &nbsp;<span class="b-sub">' + esc(c.place) + "</span></div>" +
        '<span class="tz-badge ' + (c.status === "ok" ? "ok" : (c.status === "warn" ? "warn" : "info")) + '">' + esc(c.statusText) + "</span></div>" +
        '<p class="section-note"><b>' + esc(c.connector) + "</b> · app " + c.kw.nominal + " kW · reportado " + c.kw.realista + " kW</p>" +
        '<p class="section-note" style="margin-top:6px">' + esc(c.notes) + "</p></div>";
    }).join("");
  }

  function candidatesHtml() {
    return D.candidates.map(function (c) {
      return '<div class="grid-kv"><span class="grid-kv-label"><b>' + esc(c.name) + "</b><br>" + esc(c.text) + "</span>" +
        (c.link ? '<a class="grid-kv-value" href="' + esc(c.link) + '" target="_blank" rel="noopener noreferrer">abrir</a>' : "") + "</div>";
    }).join("");
  }

  function reportsHtml() {
    return '<div class="grid-table-wrap"><table class="grid-table"><thead><tr><th>Fecha</th><th>Carro</th><th>Ruta</th><th>Qué pasó</th></tr></thead><tbody>' +
      D.reports.map(function (r) {
        return "<tr><td>" + esc(r.date) + "</td><td>" + esc(r.car) + "</td><td>" + esc(r.route) + "</td><td>" + esc(r.text) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  function checklistHtml() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem("tz-checklist") || "{}"); } catch (e) { saved = {}; }
    return D.checklist.map(function (t, i) {
      return '<label class="tz-check tz-todo"><input type="checkbox" data-todo="' + i + '"' + (saved[i] ? " checked" : "") + "> " + esc(t) + "</label>";
    }).join("");
  }

  function onTodo(e) {
    var i = e.target.getAttribute && e.target.getAttribute("data-todo");
    if (i === null || i === undefined) return;
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem("tz-checklist") || "{}"); } catch (err) { saved = {}; }
    saved[i] = e.target.checked;
    try { localStorage.setItem("tz-checklist", JSON.stringify(saved)); } catch (err2) { /* modo privado: no persistir */ }
  }

  // ====================================================================
  // Montaje del panel
  // ====================================================================

  function panelHtml() {
    return '' +
    '<section class="block" id="tz-sim-top">' +
      '<div class="section-head"><h2>⚡ Ruta Tesla · Medellín ⇄ Coveñas</h2><p class="section-note">Model Y RWD · ruta nueva por Barbosa, Cisneros, Remedios y Caucasia, sin pasar por Sincelejo</p></div>' +
      '<div class="notes"><b>Lo que dicen los reportes reales</b><br>' +
        'Sin cargar no se llega: Popalito→Fátima gasta ~75% de la batería. <b>Fátima es el punto crítico</b> (único rápido en ~300 km, rinde ~20 kW y a veces falla). ' +
        'Si Fátima falla, la salida es llegar a Montería en modo Eco (~15%) donde están MubOn La Castellana (60 kW) y Places Mall (11 kW). ' +
        'El <b>regreso</b> Fátima→Popalito consume ~27% más y es el tramo más difícil. Los números son estimaciones calibradas con esos reportes, no garantías.</div>' +
    '</section>' +

    '<section class="block"><div class="section-head"><h2>Escenarios</h2><p class="section-note">Toca uno para cargarlo y ajustarlo abajo</p></div>' +
      '<div class="tz-chips" id="tz-presets"></div></section>' +

    '<section class="block"><div class="section-head"><h2>Supuestos</h2></div><div class="b-card">' +
      '<div class="tz-seg" role="group" aria-label="Sentido"><button type="button" id="tz-dir-ida" data-dir="ida">Ida · Medellín → Coveñas</button>' +
      '<button type="button" id="tz-dir-regreso" data-dir="regreso">Regreso · Coveñas → Medellín</button></div>' +
      '<div class="tz-grid2">' +
        '<label>Ruta<select id="tz-route">' + Object.keys(D.routes).map(function (k) { return '<option value="' + k + '">' + esc(D.routes[k].label) + "</option>"; }).join("") + "</select></label>" +
        '<label>Estilo de manejo' + selectHtml("tz-style", D.styles, state.style) + "</label>" +
        '<label>Pasajeros y equipaje' + selectHtml("tz-load", D.loads, state.load) + "</label>" +
        '<label>Cómo se portan los cargadores' + selectHtml("tz-scenario", D.scenarios, state.scenario) + "</label>" +
        '<label>Batería al salir: <b id="tz-start-v"></b><input id="tz-start" type="range" min="20" max="100" step="1"></label>' +
        '<label>Reserva mínima de llegada: <b id="tz-reserve-v">' + state.reserve + '%</b><input id="tz-reserve" type="range" min="5" max="30" step="1" value="' + state.reserve + '"></label>' +
        '<label>Hora de salida<input id="tz-depart" type="time" value="' + state.depart + '"></label>' +
        '<label>Batería útil (kWh)<input id="tz-usable" type="number" min="40" max="90" step="0.5" value="' + state.usable + '"></label>' +
        '<label>Precio de la carga ($/kWh)<input id="tz-price" type="number" min="0" step="50" value="' + state.price + '"></label>' +
        '<label>kW del punto hipotético<input id="tz-customkw" type="number" min="1" max="150" step="1" value="' + state.customKw + '"></label>' +
      "</div></div></section>" +

    '<section class="block"><div class="section-head"><h2>Paradas de carga</h2><p class="section-note">Activa y ajusta dónde cargar</p></div><div id="tz-stops" class="balance-list"></div></section>' +

    '<section class="block"><div class="section-head"><h2>Resultado</h2><div id="tz-verdict"></div></div>' +
      '<div class="stats tz-kpis" id="tz-kpis"></div>' +
      '<div class="b-card" style="margin-top:14px" id="tz-chart"></div>' +
      '<ul class="tz-alerts" id="tz-alerts"></ul><div id="tz-timeline"></div></section>' +

    '<section class="block"><div class="section-head"><h2>¿Y si falla un cargador?</h2><p class="section-note">Mismo plan, saltándose cada parada</p></div><div id="tz-failmatrix"></div></section>' +

    '<section class="block"><div class="section-head"><h2>Comparar escenarios</h2><p class="section-note">Con tus supuestos de arriba · toca una fila para abrirla</p></div><div id="tz-compare"></div></section>' +

    '<section class="block"><div class="section-head"><h2>Cargar en la cabaña</h2><p class="section-note">Para el regreso</p></div><div class="b-card">' + cabanaHtml() + "</div></section>" +

    '<section class="block"><div class="section-head"><h2>Cargadores de la ruta</h2><p class="section-note">Lo que se sabe y lo que no</p></div><div class="balance-list">' + chargersHtml() + "</div></section>" +

    '<section class="block"><div class="section-head"><h2>Por investigar</h2><p class="section-note">Ninguno está confirmado</p></div><div class="b-card">' + candidatesHtml() + "</div></section>" +

    '<section class="block"><div class="section-head"><h2>Viajes reales</h2><p class="section-note">Sin nombres · grupos de WhatsApp</p></div>' + reportsHtml() + "</section>" +

    '<section class="block"><div class="section-head"><h2>Checklist</h2><p class="section-note">Se guarda en este navegador</p></div><div class="b-card" id="tz-checklist">' + checklistHtml() + "</div></section>" +

    '<section class="block"><div class="notes"><b>Fuentes y límites</b><br>' + D.sources.map(esc).join("<br>") +
      "<br>Los consumos son estimaciones; la pantalla del Tesla y ABRP mandan el día del viaje.</div></section>";
  }

  function mount() {
    var tabbar = document.querySelector(".tabbar");
    var wrap = document.querySelector(".wrap");
    var footer = document.getElementById("footer-note");
    if (!tabbar || !wrap || !footer || document.getElementById("panel-tesla")) return;

    var btn = document.createElement("button");
    btn.className = "tab-btn";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", "false");
    btn.dataset.tab = "tesla";
    btn.textContent = "⚡ Tesla";
    tabbar.appendChild(btn);
    if (window.__wireTabClick) window.__wireTabClick(btn);

    var panel = document.createElement("div");
    panel.className = "tabpanel";
    panel.id = "panel-tesla";
    panel.innerHTML = panelHtml();
    wrap.insertBefore(panel, footer);

    applyPreset(state.preset);
    renderControls();
    renderResults();
    updateCabana();
    if (location.hash === "#tesla") btn.click();

    panel.addEventListener("input", function (e) {
      if (e.target.id && e.target.id.indexOf("tz-cab-") === 0) updateCabana();
      else onChange(e);
    });
    panel.addEventListener("change", function (e) {
      if (e.target.id && e.target.id.indexOf("tz-cab-") === 0) updateCabana();
      else onChange(e);
      onTodo(e);
    });
    panel.addEventListener("click", onClick);
  }

  window.TeslaSim = { simulate: simulate };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
