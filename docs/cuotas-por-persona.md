# Cuotas por persona (pestaña "Cuotas" de la hoja)

Muestra cuánto debe cada persona de la cabaña. Los abonos se hicieron por familia, así que se aplican
en cascada: primero cubren la cuota del **principal** de la familia; cuando la cubren, lo que sobra pasa
a la siguiente persona, y así hasta agotar el abono. Lo que queda sin cubrir es lo que debe cada uno.

El cálculo vive en la hoja (fórmulas), no en el código. El dashboard solo lo lee: si existe la pestaña
"Cuotas", la vista **Personas** usa sus números y la pestaña aparece en la página junto a Personas.
Si no existe, la página sigue con el reparto proporcional de antes.

## Instalar (una sola vez)

1. **Haz una copia de seguridad**: en la hoja, *Archivo → Hacer una copia*.
2. En la hoja original: *Extensiones → Apps Script*.
3. Borra lo que haya en el editor, pega completo [`sheet/crear-pestana-cuotas.gs`](sheet/crear-pestana-cuotas.gs)
   y guarda (icono de disco).
4. Elige la función `crearPestanaCuotas` y pulsa *Ejecutar*. Google pide permiso para editar la hoja:
   acéptalo (es tu propio script).
5. Al terminar sale un aviso. Revisa los controles (abajo).

El script solo escribe en la pestaña "Cuotas"; no toca Personas, Abonos, Cabaña ni ninguna otra.
Antes de escribir comprueba que esas pestañas tengan la estructura esperada (encabezados en la fila 2 de
Personas y Abonos, y "Costo total" en `Cabaña!A5`); si algo no cuadra, se detiene sin cambiar nada.

Se puede volver a ejecutar sin riesgo: reescribe las fórmulas y conserva lo que hayas marcado en la
columna L.

## Cómo leer la pestaña

| Columna | Qué es |
|---|---|
| Cuota cabaña | noches × tarifa por persona-noche |
| Cubierto | lo que el abono de la familia alcanza a cubrirle a esta persona |
| Falta | cuota − cubierto |
| Estado | "Al día" o "Debe" |
| Abonos de la familia | suma de lo que abonó cada miembro |
| Abonó directo | lo que esta persona registró a su nombre en Abonos |
| Rol / Orden | "Principal" (orden 1) o "Familiar", en el orden de la pestaña Personas |
| Principal manual | opcional, ver abajo |

## Cambiar el principal de una familia

Por defecto el principal es la **primera persona de la familia** en la pestaña Personas. Para elegir
otra, escribe una **X** en la columna L (*Principal manual*) de esa persona. Solo una por familia; si
hay varias, cuenta la primera. Si reordenas Personas, revisa esta columna.

## Controles (filas 4 a 11)

| Celda | Debe dar | Si no |
|---|---|---|
| B5 | el costo total de la cabaña | revisa `Cabaña!B5` |
| B9 | 0 (cuotas − costo de la cabaña) | las fórmulas se dañaron: vuelve a ejecutar el script |
| B10 | 0 (abonos sin persona asignada) | hay un abono con un nombre que no está escrito igual en Personas |
| B11 | normalmente 0 | una familia abonó más de lo que le toca; ese sobrante no se pasa a otras familias |

## Límites

- Hasta **48 personas** (filas 13 a 60). Si Personas pasa de 48, las que sobran no aparecen y la tarifa sale mal: hay que ampliar `CUOTAS.LAST` en el script.
- **Solo la cabaña.** Los gastos variables no entran aquí.
- **Un principal por familia.** La cascada es dentro de cada familia; no se mueve dinero entre familias.
- Una persona sin familia en Personas cuenta como su propia familia.
- Los nombres de Abonos deben coincidir exactamente con los de Personas.
