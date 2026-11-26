/**
 * Crea (o refresca) la pestaña "Cuotas" en la hoja de cálculo del viaje.
 *
 * Qué calcula: los abonos se hicieron por familia, así que se aplican primero a la
 * cuota del principal de cada familia; cuando la cubre, lo que sobra pasa a la
 * siguiente persona de esa familia, y así hasta agotar el abono. Lo que quede sin
 * cubrir es lo que debe cada persona.
 *
 * Cómo usarlo (una sola vez): en la hoja, Extensiones > Apps Script, pegar este
 * archivo completo, guardar y ejecutar `crearPestanaCuotas`. Google pedirá permiso
 * para editar esta hoja. Solo escribe en la pestaña "Cuotas"; no toca Personas,
 * Abonos, Cabaña ni ninguna otra.
 *
 * Es seguro volver a ejecutarlo: reescribe las fórmulas y conserva la columna L
 * (principal manual) que hayas llenado.
 *
 * Detalle y límites: docs/cuotas-por-persona.md en el repositorio.
 */

var CUOTAS = {
  SHEET: 'Cuotas',
  FIRST: 13,   // primera fila de personas en la pestaña Cuotas
  LAST: 60,    // última fila (capacidad: 48 personas)
  OFFSET: 10   // la fila r de Cuotas lee la fila r - OFFSET de Personas
};

function crearPestanaCuotas() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  verificarEstructura_(ss);

  var sh = ss.getSheetByName(CUOTAS.SHEET) || ss.insertSheet(CUOTAS.SHEET);
  var sep = separadorDeArgumentos_(sh);
  var F = CUOTAS.FIRST, L = CUOTAS.LAST;
  var n = L - F + 1;

  // --- Título y explicación ---
  sh.getRange('A1').setValue('💰 CUOTAS POR PERSONA · lo que debe cada uno');
  sh.getRange('A2').setValue(
    'Los abonos se hicieron por familia. Se aplican primero a la cuota del principal; cuando la cubre, ' +
    'el resto pasa a la siguiente persona de la familia. Principal = la primera persona de la familia en ' +
    'la pestaña Personas, o la que marques con una X en la columna L. Solo cuenta la cabaña; los gastos variables no entran aquí.');

  // --- Resumen y controles (filas 4 a 11) ---
  var resumen = [
    ['Tarifa por persona-noche',
      '=IF(SUM($G$' + F + ':$G$' + L + ')=0,0,\'Cabaña\'!$B$5/SUM($G$' + F + ':$G$' + L + '))'],
    ['Costo total de la cabaña', '=\'Cabaña\'!$B$5'],
    ['Total abonado', '=SUMIF(\'Abonos\'!$A$3:$A$500,"<>TOTAL*",\'Abonos\'!$E$3:$E$500)'],
    ['Falta por pagar de la cabaña', '=SUM($E$' + F + ':$E$' + L + ')'],
    ['Personas que aún deben', '=COUNTIF($F$' + F + ':$F$' + L + ',"Debe")'],
    ['Control · cuotas menos costo de la cabaña (debe ser 0)',
      '=ROUND(SUM($C$' + F + ':$C$' + L + ')-\'Cabaña\'!$B$5,0)'],
    ['Control · abonos sin persona asignada (debe ser 0)',
      '=ROUND(B6-SUM($I$' + F + ':$I$' + L + '),0)'],
    ['Abonos de más (sobran después de cubrir a toda la familia)',
      '=ROUND(SUM($I$' + F + ':$I$' + L + ')-SUM($D$' + F + ':$D$' + L + '),0)']
  ];
  sh.getRange(4, 1, resumen.length, 1).setValues(resumen.map(function (r) { return [r[0]]; }));
  sh.getRange(4, 2, resumen.length, 1).setFormulas(resumen.map(function (r) { return [conSeparador_(r[1], sep)]; }));

  // --- Encabezados (fila 12) ---
  sh.getRange(F - 1, 1, 1, 12).setValues([[
    'Nombre', 'Familia', 'Cuota cabaña', 'Cubierto', 'Falta', 'Estado',
    'Noches', 'Abonos de la familia', 'Abonó directo', 'Rol', 'Orden', 'Principal manual (opcional)'
  ]]);

  // --- Una fila por persona (columnas A a K; la L es manual y no se toca) ---
  var filas = [];
  for (var r = F; r <= L; r++) {
    filas.push(formulasFila_(r).map(function (f) { return conSeparador_(f, sep); }));
  }
  sh.getRange(F, 1, n, 11).setFormulas(filas);

  darFormato_(sh);

  var msg = 'Pestaña "Cuotas" lista.\n\nRevisa en la pestaña:\n' +
    '• B5 debe ser el costo total de la cabaña.\n' +
    '• B9 y B10 deben dar 0.\n\n' +
    'Si algo no cuadra, no cambies nada en Personas ni en Abonos: avísame primero.';
  // Aviso no bloqueante: un alert() espera a que alguien pulse "Aceptar" en la hoja y,
  // si se ejecuta desde el editor, la ejecución se corta a los 6 minutos.
  SpreadsheetApp.flush();
  sh.activate();
  ss.toast('B5 = costo de la cabaña; B9 y B10 deben dar 0.', 'Pestaña "Cuotas" lista', 15);
  Logger.log(msg);
}

/**
 * Las fórmulas se escriben con coma entre argumentos, pero en hojas con configuración
 * regional que usa coma decimal (español, por ejemplo) el separador es punto y coma, y
 * setFormula no lo traduce: queda "#ERROR!" (error de análisis). Se prueba en una celda
 * libre cuál acepta esta hoja.
 */
function separadorDeArgumentos_(sh) {
  var celda = sh.getRange('Z1');
  celda.setFormula('=SUM(1,2)');
  SpreadsheetApp.flush();
  var acepta = celda.getValue() === 3;
  celda.clearContent();
  return acepta ? ',' : ';';
}

/** Cambia las comas que separan argumentos por `sep`, sin tocar las que estén dentro de "texto". */
function conSeparador_(formula, sep) {
  if (sep === ',') return formula;
  var out = '', enTexto = false;
  for (var i = 0; i < formula.length; i++) {
    var ch = formula.charAt(i);
    if (ch === '"') enTexto = !enTexto;
    out += (ch === ',' && !enTexto) ? sep : ch;
  }
  return out;
}

/** Fórmulas de las columnas A a K para la fila r de Cuotas. */
function formulasFila_(r) {
  var F = CUOTAS.FIRST, L = CUOTAS.LAST;
  var p = r - CUOTAS.OFFSET;
  var P = '\'Personas\'!';
  var B = '$B$' + F + ':$B$' + L;
  var Brow = '$B$' + F + ':B' + r;       // desde la primera fila hasta esta
  var Lcol = '$L$' + F + ':$L$' + L;
  var Lrow = '$L$' + F + ':L' + r;
  var Jrow = '$J$' + F + ':J' + r;
  var vacia = 'A' + r + '=""';

  return [
    // A Nombre (se salta filas vacías y la fila "Total ..." de Personas)
    '=IF(OR(' + P + 'A' + p + '="",LEFT(' + P + 'A' + p + ',5)="Total"),"",' + P + 'A' + p + ')',
    // B Familia (si no tiene familia, cuenta como su propia familia)
    '=IF(' + vacia + ',"",IF(' + P + 'B' + p + '="",A' + r + ',' + P + 'B' + p + '))',
    // C Cuota de la cabaña = noches x tarifa por persona-noche
    '=IF(' + vacia + ',"",IF(SUM($G$' + F + ':$G$' + L + ')=0,0,G' + r + '*\'Cabaña\'!$B$5/SUM($G$' + F + ':$G$' + L + ')))',
    // D Cubierto: lo que alcanza del abono de la familia después de cubrir a quienes van antes
    '=IF(' + vacia + ',"",MAX(0,MIN(C' + r + ',H' + r + '-SUMIFS($C$' + F + ':$C$' + L + ',' + B + ',B' + r +
      ',$K$' + F + ':$K$' + L + ',"<"&K' + r + '))))',
    // E Falta
    '=IF(' + vacia + ',"",MAX(0,C' + r + '-D' + r + '))',
    // F Estado
    '=IF(' + vacia + ',"",IF(E' + r + '<1,"Al día","Debe"))',
    // G Noches
    '=IF(' + vacia + ',"",N(' + P + 'C' + p + '))',
    // H Abonos de la familia (suma de lo que abonó cada miembro)
    '=IF(' + vacia + ',"",SUMIF(' + B + ',B' + r + ',$I$' + F + ':$I$' + L + '))',
    // I Abonó directo (por nombre, en la pestaña Abonos)
    '=IF(' + vacia + ',"",SUMIF(\'Abonos\'!$B$3:$B$500,A' + r + ',\'Abonos\'!$E$3:$E$500))',
    // J Rol: la primera marca manual de la familia, o la primera persona listada si no hay marca.
    // (Se cuenta con SUMPRODUCT y LEN en vez de COUNTIFS "<>" para no depender de cómo cada programa trata las celdas vacías.)
    '=IF(' + vacia + ',"",IF(IF(SUMPRODUCT((' + B + '=B' + r + ')*(LEN(' + Lcol + ')>0))>0,' +
      'AND(LEN(L' + r + ')>0,SUMPRODUCT((' + Brow + '=B' + r + ')*(LEN(' + Lrow + ')>0))=1),' +
      'COUNTIF(' + Brow + ',B' + r + ')=1),"Principal","Familiar"))',
    // K Orden dentro de la familia: el principal es 1; los demás siguen el orden de Personas
    '=IF(' + vacia + ',"",IF(J' + r + '="Principal",1,1+COUNTIFS(' + Brow + ',B' + r + ',' + Jrow + ',"Familiar")))'
  ];
}

/** Comprueba que Personas, Abonos y Cabaña tengan la estructura que suponen las fórmulas. */
function verificarEstructura_(ss) {
  var problemas = [];
  function norm(v) {
    return String(v === null || v === undefined ? '' : v).toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  function espera(nombreHoja, rango, esperados) {
    var hoja = ss.getSheetByName(nombreHoja);
    if (!hoja) { problemas.push('No existe la pestaña "' + nombreHoja + '".'); return; }
    var vals = hoja.getRange(rango).getValues()[0];
    esperados.forEach(function (e, i) {
      if (norm(vals[i]).indexOf(e) === -1) {
        problemas.push(nombreHoja + '!' + rango.split(':')[0] + ' (columna ' + (i + 1) + '): se esperaba "' + e +
          '" y hay "' + vals[i] + '".');
      }
    });
  }
  espera('Personas', 'A2:C2', ['nombre', 'grupo', 'noches']);
  espera('Abonos', 'A2:E2', ['fecha', 'nombre', 'grupo', 'concepto', 'valor']);
  var cab = ss.getSheetByName('Cabaña');
  if (!cab) {
    problemas.push('No existe la pestaña "Cabaña".');
  } else if (norm(cab.getRange('A5').getValue()).indexOf('costo total') === -1) {
    problemas.push('Cabaña!A5 debería decir "Costo total ..." y dice "' + cab.getRange('A5').getValue() + '".');
  }
  if (problemas.length) {
    throw new Error('La estructura de la hoja no es la esperada; no se hizo ningún cambio.\n' + problemas.join('\n'));
  }
}

/** Formato visual: números, encabezados, estados y anchos de columna. */
function darFormato_(sh) {
  var F = CUOTAS.FIRST, L = CUOTAS.LAST;

  sh.getRange('A1').setFontWeight('bold').setFontSize(14);
  sh.getRange('A2').setFontColor('#4C6A67');
  sh.getRange('A4:A11').setFontColor('#4C6A67');
  sh.getRange('B4:B11').setFontWeight('bold').setHorizontalAlignment('right');
  sh.getRange('B4:B7').setNumberFormat('#,##0');
  sh.getRange('B8').setNumberFormat('0');
  sh.getRange('B9:B11').setNumberFormat('#,##0');

  var enc = sh.getRange(F - 1, 1, 1, 12);
  enc.setFontWeight('bold').setBackground('#0E5C63').setFontColor('#FFFFFF').setWrap(true);
  sh.getRange(F - 1, 12).setNote(
    'Opcional. Escribe una X en la persona que debe ser la principal de su familia (solo una por familia). ' +
    'Si no marcas a nadie, la principal es la primera de la familia en la pestaña Personas. ' +
    'Si cambias el orden de Personas, revisa esta columna.');

  sh.getRange(F, 3, L - F + 1, 3).setNumberFormat('#,##0');   // C, D, E
  sh.getRange(F, 7, L - F + 1, 1).setNumberFormat('0.##');    // G noches
  sh.getRange(F, 8, L - F + 1, 2).setNumberFormat('#,##0');   // H, I
  sh.getRange(F, 12, L - F + 1, 1).setBackground('#FBF1E1');  // L: celda de entrada manual

  var rango = sh.getRange(F, 6, L - F + 1, 1);                // F Estado
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Debe')
      .setBackground('#FBEAE7').setFontColor('#C24B3F').setRanges([rango]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Al día')
      .setBackground('#E4F4EC').setFontColor('#2F9C6B').setRanges([rango]).build()
  ]);

  var anchos = [190, 110, 110, 110, 110, 80, 70, 130, 110, 90, 70, 170];
  anchos.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
}
