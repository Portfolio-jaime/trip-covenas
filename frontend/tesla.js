// Página "Ruta Tesla" (tesla.html): simulador de la ruta Medellín ⇄ Coveñas en Model Y RWD.
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

    var nStops = res.steps.filter(function (x) { return x.type === "stop"; }).length;
    var dest = state.dir === "ida" ? "Coveñas" : "Medellín";
    el("tz-headline").innerHTML = res.ok
      ? '<div class="tz-big">Llegas a ' + dest + " con <b>" + pct(res.arriveSoc) + "</b></div>" +
        '<div class="tz-muted">Salida ' + state.depart + " → llegada " + clock(depart + res.totalMin) + " · " +
        nStops + (nStops === 1 ? " parada" : " paradas") + " de carga · " + Math.round(res.km) + " km</div>"
      : '<div class="tz-big bad">Con este plan no llegas</div><div class="tz-muted">La batería se agota entre ' +
        esc(nodeName(res.failAt.from).split(" (")[0]) + " y " + esc(nodeName(res.failAt.to).split(" (")[0]) + ".</div>";
    el("tz-verdict").innerHTML = verdictBadge(res.verdict, state.reserve) +
      ' <span class="tz-muted">Mínimo en ruta: <b>' + pct(Math.max(res.minSoc, 0)) + "</b></span>";

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
  // Asistente (chat con Groq vía /api/chat)
  // ====================================================================

  var SUGGESTIONS = [
    "¿Está funcionando hoy el cargador de Fátima?",
    "¿Qué hago si Fátima está fuera de servicio?",
    "Armo el regreso con 5 personas, ¿cómo lo ves?",
    "¿Hay algún cargador nuevo entre Caucasia y Montería?"
  ];
  var chatHistory = [];
  var chatBusy = false;

  function chatUrl() {
    var api = window.DASHBOARD_API_URL || "";
    return /\/summary$/.test(api) ? api.replace(/\/summary$/, "/chat") : "";
  }

  // Resumen compacto de datos + estado del simulador para el modelo. El
  // servidor limita su tamaño (6000 caracteres), así que se recorta aquí.
  function cut(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  function buildContext() {
    var res = simulate(cfgOf(state));
    var lines = ["VEHÍCULO: Model Y RWD, batería útil " + state.usable + " kWh."];
    lines.push("CARGADORES:");
    Object.keys(D.chargers).forEach(function (k) {
      var c = D.chargers[k];
      lines.push("- " + c.name + " (" + cut(c.place, 70) + "): app " + c.kw.nominal + " kW, real " + c.kw.realista +
        " kW, " + c.statusText + ". " + cut(c.notes, 170));
    });
    lines.push("TRAMOS (km, Wh/km ida): " + Object.keys(D.legs).map(function (k) {
      return k + " " + D.legs[k].km + "/" + D.legs[k].wh;
    }).join("; ") + ". Regreso Fátima→Popalito gasta ~27% más.");
    lines.push("REPORTES REALES:");
    D.reports.forEach(function (r) { lines.push("- " + r.date + " " + cut(r.route, 40) + ": " + cut(r.text, 150)); });
    lines.push("SIMULACIÓN ACTUAL: " + state.dir + ", ruta " + state.route + ", sale con " + state.startSoc + "%, estilo " + state.style +
      ", reserva " + state.reserve + "%, cargadores '" + state.scenario + "'.");
    lines.push("Paradas: " + (Object.keys(state.stops).filter(function (k) { return state.stops[k].charge; }).map(function (k) {
      return k + "→" + state.stops[k].target + "%";
    }).join(", ") || "ninguna"));
    lines.push("Resultado: " + (res.ok ? "llega con " + Math.round(res.arriveSoc) + "%" : "NO llega") + ", mínimo " +
      Math.round(Math.max(res.minSoc, 0)) + "%, total " + dur(res.totalMin) + ", cargando " + dur(res.chargeMin) + ".");
    return cut(lines.join("\n"), 5800);
  }

  // Interpreta la respuesta: texto + (opcional) bloque ```plan {...}```.
  function splitReply(reply) {
    var m = /```plan\s*([\s\S]*?)```/.exec(reply);
    var text = reply.replace(/```plan[\s\S]*?```/g, "").trim();
    var plan = null;
    if (m) { try { plan = sanitizePlan(JSON.parse(m[1])); } catch (e) { plan = null; } }
    return { text: text, plan: plan };
  }

  // El plan viene de un modelo: solo se aceptan campos y valores conocidos.
  function sanitizePlan(p) {
    if (!p || typeof p !== "object") return null;
    var out = { stops: {} };
    if (p.dir === "ida" || p.dir === "regreso") out.dir = p.dir;
    if (D.routes[p.route]) out.route = p.route;
    if (typeof p.startSoc === "number" && p.startSoc >= 20 && p.startSoc <= 100) out.startSoc = Math.round(p.startSoc);
    if (D.styles[p.style]) out.style = p.style;
    var stops = p.stops && typeof p.stops === "object" ? p.stops : {};
    Object.keys(stops).forEach(function (id) {
      var node = D.nodes[id], s = stops[id];
      if (!node || !node.chargers.length || !s || typeof s.target !== "number") return;
      var entry = { charge: true, target: Math.max(30, Math.min(100, Math.round(s.target / 5) * 5)) };
      if (s.charger && node.chargers.indexOf(s.charger) !== -1) entry.charger = s.charger;
      out.stops[id] = entry;
    });
    return Object.keys(out).length > 1 || Object.keys(out.stops).length ? out : null;
  }

  function applyPlan(plan) {
    ["dir", "route", "startSoc", "style"].forEach(function (k) { if (plan[k] !== undefined) state[k] = plan[k]; });
    state.stops = plan.stops;
    state.preset = "";
    renderControls();
    renderResults();
    showSub("plan");
  }

  // Markdown mínimo y seguro para las respuestas del asistente. Todo se escapa
  // primero; después solo se reconstruyen etiquetas conocidas (párrafos, listas,
  // tablas, negritas, cursivas, código y enlaces https).
  function mdInline(raw) {
    var s = esc(raw);
    s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<i>$2</i>")
      .replace(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https:\/\/[^\s<)\]]+?)([.,;:]?)(?=$|[\s<)])/g, function (m, pre, url, tail) {
        return pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' +
          url.replace(/^https:\/\//, "").slice(0, 44) + "</a>" + tail;
      });
    return s;
  }

  function mdCells(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); });
  }

  function richText(text) {
    // Marcas de cita de la búsqueda web (【2†L6-L10】) no aportan al lector.
    var lines = String(text).replace(/【[^】]*】/g, "").replace(/\r/g, "").split("\n");
    var out = [], para = [], list = null;

    function flushPara() { if (para.length) { out.push("<p>" + para.join("<br>") + "</p>"); para = []; } }
    function flushList() { if (list) { out.push("<" + list.tag + ">" + list.items.join("") + "</" + list.tag + ">"); list = null; } }
    function flush() { flushPara(); flushList(); }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i], m;
      if (!line.trim()) { flush(); continue; }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flush(); continue; }
      if ((m = /^\s*#{1,6}\s+(.*)$/.exec(line))) { flush(); out.push("<h4>" + mdInline(m[1]) + "</h4>"); continue; }
      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        flush();
        var head = mdCells(line), rows = [];
        i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(mdCells(lines[i])); i++; }
        i--;
        out.push('<div class="tz-md-table"><table><thead><tr>' + head.map(function (c) { return "<th>" + mdInline(c) + "</th>"; }).join("") +
          "</tr></thead><tbody>" + rows.map(function (r) {
            return "<tr>" + r.map(function (c) { return "<td>" + mdInline(c) + "</td>"; }).join("") + "</tr>";
          }).join("") + "</tbody></table></div>");
        continue;
      }
      if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) {
        flushPara();
        if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; }
        list.items.push("<li>" + mdInline(m[1]) + "</li>");
        continue;
      }
      if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
        flushPara();
        if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; }
        list.items.push("<li>" + mdInline(m[1]) + "</li>");
        continue;
      }
      flushList();
      para.push(mdInline(line.trim()));
    }
    flush();
    return out.join("");
  }

  function addBubble(role, html, extra) {
    var box = el("tz-msgs");
    var div = document.createElement("div");
    div.className = "tz-msg " + role;
    div.innerHTML = html + (extra || "");
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  var CHAT_ERRORS = {
    429: "Groq está al límite del plan gratis. Espera un minuto y vuelve a intentar.",
    503: "El asistente todavía no está activado (falta la clave de Groq en el servidor).",
    504: "La búsqueda web tardó demasiado. Intenta de nuevo con una pregunta más corta.",
    403: "Este sitio no está autorizado para usar el asistente."
  };

  function sendChat(question) {
    question = (question || "").trim();
    if (!question || chatBusy) return;
    var url = chatUrl();
    addBubble("user", esc(question));
    if (!url) { addBubble("bot error", "El asistente no está configurado en este sitio."); return; }
    chatHistory.push({ role: "user", content: question });
    chatBusy = true;
    el("tz-send").disabled = true;
    var thinking = addBubble("bot thinking", "Consultando datos y buscando en la web…");
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatHistory.slice(-6), context: buildContext() })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b }; });
    }).then(function (r) {
      thinking.remove();
      if (r.status !== 200 || !r.body.reply) {
        chatHistory.pop();
        addBubble("bot error", esc(CHAT_ERRORS[r.status] || "No pude responder ahora. Intenta de nuevo en un momento."));
        return;
      }
      chatHistory.push({ role: "assistant", content: r.body.reply });
      var parts = splitReply(r.body.reply);
      var btn = parts.plan ? '<button type="button" class="tz-chip tz-apply">▶ Simular este plan</button>' : "";
      var bubble = addBubble("bot", richText(parts.text || "Listo."), btn);
      if (parts.plan) bubble.querySelector(".tz-apply").onclick = function () { applyPlan(parts.plan); };
    }).catch(function () {
      thinking.remove();
      chatHistory.pop();
      addBubble("bot error", "Sin conexión con el asistente. Revisa tu internet e intenta de nuevo.");
    }).then(function () {
      chatBusy = false;
      el("tz-send").disabled = false;
    });
  }

  function chatPanelHtml() {
    return '<div class="tz-chat">' +
      '<div class="tz-msgs" id="tz-msgs" aria-live="polite">' +
        '<div class="tz-msg bot">Hola 👋 Soy el asistente de la ruta. Conozco los cargadores, los reportes de otros conductores y el plan que tienes en el simulador, y puedo buscar en la web el estado actual. Pregúntame lo que quieras o pídeme que arme un plan.</div>' +
      "</div>" +
      '<div class="tz-suggest">' + SUGGESTIONS.map(function (q) {
        return '<button type="button" class="tz-chip" data-ask="' + esc(q) + '">' + esc(q) + "</button>";
      }).join("") + "</div>" +
      '<form class="tz-form" id="tz-form"><input id="tz-input" type="text" maxlength="500" autocomplete="off" placeholder="Escribe tu pregunta…" aria-label="Pregunta para el asistente">' +
      '<button type="submit" id="tz-send" class="tz-send">Enviar</button></form>' +
      '<p class="tz-fine">Respuestas generadas por IA con búsqueda web. Verifica el estado de los cargadores antes de salir.</p>' +
    "</div>";
  }

  // ====================================================================
  // Secciones estáticas
  // ====================================================================

  function chargersHtml() {
    return Object.keys(D.chargers).filter(function (k) { return k !== "hipotesis"; }).map(function (k) {
      var c = D.chargers[k];
      return '<div class="tz-card"><div class="tz-card-top"><div><div class="tz-card-title">' + esc(c.name) + '</div><div class="tz-muted">' + esc(c.place) + "</div></div>" +
        '<span class="tz-badge ' + (c.status === "ok" ? "ok" : (c.status === "warn" ? "warn" : "info")) + '">' + esc(c.statusText) + "</span></div>" +
        '<div class="tz-specs"><span><b>' + c.kw.nominal + " kW</b> app</span><span><b>" + c.kw.realista + " kW</b> reportado</span><span>" + esc(c.connector) + "</span></div>" +
        '<p class="tz-card-text">' + esc(c.notes) + "</p></div>";
    }).join("");
  }

  function candidatesHtml() {
    return D.candidates.map(function (c) {
      return '<div class="tz-todo-item"><div><b>' + esc(c.name) + '</b><div class="tz-muted">' + esc(c.text) + "</div></div>" +
        (c.link ? '<a class="tz-link" href="' + esc(c.link) + '" target="_blank" rel="noopener noreferrer">Abrir ↗</a>' : "") + "</div>";
    }).join("");
  }

  function reportsHtml() {
    return D.reports.map(function (r) {
      return '<div class="tz-card"><div class="tz-card-top"><div class="tz-card-title">' + esc(r.route) + '</div><span class="tz-badge info">' +
        esc(r.date) + (r.car !== "—" ? " · " + esc(r.car) : "") + "</span></div><p class=\"tz-card-text\">" + esc(r.text) + "</p></div>";
    }).join("");
  }

  function checklistHtml() {
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem("tz-checklist") || "{}"); } catch (e) { saved = {}; }
    return D.checklist.map(function (t, i) {
      return '<label class="tz-check tz-todo"><input type="checkbox" data-todo="' + i + '"' + (saved[i] ? " checked" : "") + "> <span>" + esc(t) + "</span></label>";
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

  var SUBS = [
    { id: "plan", label: "Mi plan" },
    { id: "asistente", label: "Asistente IA" },
    { id: "cargadores", label: "Cargadores" },
    { id: "viajes", label: "Viajes reales" },
    { id: "checklist", label: "Checklist" }
  ];

  function showSub(id) {
    Array.prototype.forEach.call(document.querySelectorAll(".tz-subbtn"), function (b) {
      b.setAttribute("aria-selected", String(b.getAttribute("data-sub") === id));
    });
    Array.prototype.forEach.call(document.querySelectorAll(".tz-subpanel"), function (p) {
      p.classList.toggle("active", p.id === "tz-sub-" + id);
    });
  }

  function more(title, hint, inner) {
    return '<details class="tz-more"><summary><span>' + title + '</span><span class="tz-muted">' + hint + "</span></summary><div class=\"tz-more-body\">" + inner + "</div></details>";
  }

  function panelHtml() {
    var settings = '<div class="tz-seg" role="group" aria-label="Sentido"><button type="button" id="tz-dir-ida" data-dir="ida">Ida · a Coveñas</button>' +
      '<button type="button" id="tz-dir-regreso" data-dir="regreso">Regreso · a Medellín</button></div>' +
      '<div class="tz-grid2">' +
        '<label>Ruta<select id="tz-route">' + Object.keys(D.routes).map(function (k) { return '<option value="' + k + '">' + esc(D.routes[k].label) + "</option>"; }).join("") + "</select></label>" +
        '<label>Estilo de manejo' + selectHtml("tz-style", D.styles, state.style) + "</label>" +
        '<label>Pasajeros y equipaje' + selectHtml("tz-load", D.loads, state.load) + "</label>" +
        '<label>Cómo se portan los cargadores' + selectHtml("tz-scenario", D.scenarios, state.scenario) + "</label>" +
        '<label>Batería al salir: <b id="tz-start-v"></b><input id="tz-start" type="range" min="20" max="100" step="1"></label>' +
        '<label>Reserva mínima: <b id="tz-reserve-v">' + state.reserve + '%</b><input id="tz-reserve" type="range" min="5" max="30" step="1" value="' + state.reserve + '"></label>' +
        '<label>Hora de salida<input id="tz-depart" type="time" value="' + state.depart + '"></label>' +
        '<label>Batería útil (kWh)<input id="tz-usable" type="number" min="40" max="90" step="0.5" value="' + state.usable + '"></label>' +
        '<label>Precio de la carga ($/kWh)<input id="tz-price" type="number" min="0" step="50" value="' + state.price + '"></label>' +
        '<label>kW del punto hipotético<input id="tz-customkw" type="number" min="1" max="150" step="1" value="' + state.customKw + '"></label>' +
      "</div>";

    return '' +
    '<header class="tz-hero" id="tz-sim-top"><p class="eyebrow">Ruta en Tesla</p>' +
      "<h2>Medellín ⇄ Coveñas</h2>" +
      '<p class="tz-hero-sub">Model Y RWD · ruta nueva por Barbosa, Cisneros, Remedios y Caucasia, sin pasar por Sincelejo. Simula tu plan, mira qué pasa si algo falla y pregúntale al asistente.</p></header>' +

    '<nav class="tz-subnav" role="tablist" aria-label="Secciones de la ruta Tesla">' + SUBS.map(function (s) {
      return '<button type="button" role="tab" class="tz-subbtn" data-sub="' + s.id + '" aria-selected="' + (s.id === "plan") + '">' + s.label + "</button>";
    }).join("") + "</nav>" +

    '<div class="tz-subpanel active" id="tz-sub-plan">' +
      '<div class="tz-insights">' +
        '<div class="tz-insight"><b>Fátima manda</b><span>Es el único cargador rápido en ~300 km y rinde ~20 kW.</span></div>' +
        '<div class="tz-insight"><b>Plan B</b><span>Eco desde Popalito al 100% llega a Montería con ~15%.</span></div>' +
        '<div class="tz-insight"><b>El regreso pesa</b><span>Fátima→Popalito gasta ~27% más que la ida.</span></div>' +
      "</div>" +
      '<h3 class="tz-h3">Elige un escenario</h3><div class="tz-chips" id="tz-presets"></div>' +
      '<div class="tz-result"><div class="tz-result-head"><div id="tz-headline"></div><div id="tz-verdict"></div></div>' +
        '<div class="stats tz-kpis" id="tz-kpis"></div>' +
        '<div id="tz-chart"></div><ul class="tz-alerts" id="tz-alerts"></ul></div>' +
      more("Ajustar supuestos", "sentido, estilo, batería, precio", settings) +
      more("Paradas de carga", "dónde y hasta cuánto cargar", '<div id="tz-stops" class="tz-stops"></div>') +
      more("Detalle hora por hora", "tramos, paradas y tiempos", '<div id="tz-timeline"></div>') +
      more("¿Y si falla un cargador?", "el mismo plan sin cada parada", '<div id="tz-failmatrix"></div>') +
      more("Comparar todos los escenarios", "con tus supuestos", '<div id="tz-compare"></div>') +
      more("Cargar en la cabaña", "para el regreso", cabanaHtml()) +
    "</div>" +

    '<div class="tz-subpanel" id="tz-sub-asistente">' + chatPanelHtml() + "</div>" +

    '<div class="tz-subpanel" id="tz-sub-cargadores"><div class="tz-cards">' + chargersHtml() + "</div>" +
      '<h3 class="tz-h3">Por investigar <span class="tz-muted">· ninguno está confirmado</span></h3><div class="tz-list">' + candidatesHtml() + "</div></div>" +

    '<div class="tz-subpanel" id="tz-sub-viajes"><p class="tz-muted tz-intro">Reportes de otros conductores en los grupos de WhatsApp, sin nombres.</p><div class="tz-cards">' + reportsHtml() + "</div></div>" +

    '<div class="tz-subpanel" id="tz-sub-checklist"><div class="tz-list" id="tz-checklist">' + checklistHtml() + "</div>" +
      '<p class="tz-fine">Se guarda en este navegador. Fuentes: ' + D.sources.map(esc).join(" · ") +
      " Los consumos son estimaciones; la pantalla del Tesla y ABRP mandan el día del viaje.</p></div>";
  }

  function onSubnav(e) {
    var b = e.target.closest ? e.target.closest("[data-sub]") : null;
    if (b) showSub(b.getAttribute("data-sub"));
    var ask = e.target.closest ? e.target.closest("[data-ask]") : null;
    if (ask) sendChat(ask.getAttribute("data-ask"));
  }

  function mount() {
    var panel = document.getElementById("tesla-app");
    if (!panel) return;
    panel.classList.add("tz-root");
    panel.innerHTML = panelHtml();

    applyPreset(state.preset);
    renderControls();
    renderResults();
    updateCabana();

    panel.addEventListener("input", function (e) {
      if (e.target.id && e.target.id.indexOf("tz-cab-") === 0) updateCabana();
      else onChange(e);
    });
    panel.addEventListener("change", function (e) {
      if (e.target.id && e.target.id.indexOf("tz-cab-") === 0) updateCabana();
      else onChange(e);
      onTodo(e);
    });
    panel.addEventListener("click", function (e) { onClick(e); onSubnav(e); });
    el("tz-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var input = el("tz-input");
      var q = input.value;
      input.value = "";
      sendChat(q);
    });
  }

  window.TeslaSim = { simulate: simulate, splitReply: splitReply, richText: richText };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
