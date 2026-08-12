# Arquitectura — Coveñas Trip Dashboard

## Visión general

Google Sheets es la única fuente de verdad de los datos — la familia edita ahí desde el celular.
Todo lo demás (Lambda, API, sitio estático) es una capa de **solo lectura** que transforma esa hoja
en algo agradable de ver, sin que nadie tenga que abrir Excel ni pedirle a alguien que actualice un
resumen a mano.

```mermaid
flowchart LR
    subgraph Google["Google Cloud"]
        Sheet[("Google Sheets\nGastos_Covenas")]
        SA["Service Account\ncovenas-dashboard-reader\n(solo lectura)"]
    end

    subgraph AWS["AWS — cuenta personal 786567028012"]
        SSM["SSM Parameter Store\nclave de la Service Account\n(SecureString)"]
        Lambda["Lambda (Python 3.12)\nhandler.py"]
        APIGW["API Gateway HTTP API\nGET /api/summary"]
        S3["S3\nfrontend estático"]
        CF["CloudFront\nHTTPS, CDN"]
    end

    Browser(["Navegador\n(celular de la familia)"])

    Sheet -- "lee vía Sheets API v4" --- SA
    SSM -- "credencial de la SA" --> Lambda
    Lambda -- "batchGet" --> Sheet
    Browser -- "GET /" --> CF
    CF -- "sirve" --> S3
    Browser -- "fetch config.js → API URL" --> APIGW
    APIGW --> Lambda
    Lambda -- "JSON: totales, grupos, gastos" --> APIGW
    APIGW -- "JSON" --> Browser
```

**Por qué el Sheets sigue siendo la fuente real, y no una base de datos propia:** la familia ya
sabe editar un Sheets desde el celular; no hay que enseñarles una app nueva para registrar un
gasto. La capa de AWS solo existe para dar una vista bonita y viva de esos mismos datos.

## Flujo de una petición

```mermaid
sequenceDiagram
    participant U as Usuario (celular)
    participant CF as CloudFront
    participant S3 as S3 (frontend)
    participant AG as API Gateway
    participant L as Lambda
    participant GS as Google Sheets API

    U->>CF: GET /
    CF->>S3: origin fetch (si no está en caché)
    S3-->>CF: index.html + config.js
    CF-->>U: HTML/CSS/JS

    U->>AG: GET /api/summary (fetch desde el JS)
    AG->>L: invoke
    L->>GS: batchGet (Cabaña, Personas, Abonos, Gastos)
    GS-->>L: valores crudos (UNFORMATTED_VALUE, fechas seriales)
    Note over L: prorratea por noche/persona,<br/>agrupa por familia,<br/>filtra filas "Total X:"
    L-->>AG: JSON (totales, grupos, últimosGastos)
    AG-->>U: JSON
    Note over U: JS pinta las tarjetas de balance
```

## Lógica de negocio (vive en `lambda/handler.py`, no en el frontend)

El prorrateo se calcula server-side para que el frontend sea una vista tonta — sin esto, cambiar
una fórmula significaría tocar JS además de la hoja.

1. **Tarifa por persona-noche** = `costo total cabaña / Σ(noches de cada persona)`. Así, alguien
   que llega tarde (como Julián) paga menos automáticamente, sin caso especial en el código.
2. **Costo de cada persona** = sus noches × esa tarifa.
3. Se agrupa por `Grupo familiar` y se suma lo que debe el grupo vs. lo que ha abonado (buscado por
   nombre en la hoja `Abonos`).
4. Un grupo se marca `pending: true` si su nota o su etiqueta de grupo indica que no está
   confirmado (heurística genérica, no un nombre hardcodeado).

### Gotcha ya resuelto: filas "Total X:" fantasma

Cada hoja (`Personas`, `Abonos`, `Gastos`) termina con una fila de resumen (`Total
noches-persona:`, `TOTAL ABONADO:`, `TOTAL GASTOS:`) en la misma columna que se usa para detectar
filas de datos válidas. Sin filtrarla, se contaba a sí misma como un dato más — duplicando el total
de noches (tarifa a la mitad) y el total de gastos. `_parse_rows` ahora descarta cualquier fila cuyo
valor en esa columna empiece con "total".

### Gotcha ya resuelto: `cryptography` es un binario, no Python puro

`google-auth` usa `cryptography` (Rust compilado) para firmar el JWT de la Service Account. Un
`pip install` corrido en un Mac empaqueta el binario de macOS, que Lambda (Linux) rechaza con
`invalid ELF header`. El build (`infra/lambda.tf`) fuerza
`--platform manylinux2014_x86_64 --only-binary=:all:` para traer el wheel correcto sin importar
dónde se corra `terraform apply`.

## Seguridad

- **Service Account de solo lectura**: comparte el Sheets como Viewer, no Editor — el Lambda no
  puede escribir aunque quisiera.
- **Clave fuera de Terraform**: la key JSON se sube a SSM Parameter Store (`SecureString`) por
  fuera del apply (`aws ssm put-parameter`); Terraform solo la referencia por ARN vía data source,
  nunca la ve ni la guarda en el state.
- **Sin autenticación en el API**: es de solo lectura, la URL de CloudFront no es adivinable, y los
  datos (cuánto debe cada quien de un viaje familiar) no son sensibles. Mismo modelo de amenaza que
  ya se aceptó cuando esto era un link de Claude Artifact compartido por WhatsApp.
- **Bucket S3 privado**: acceso solo vía CloudFront con Origin Access Control (OAC), no hay lectura
  pública directa del bucket.

## Estado de Terraform

```mermaid
flowchart LR
    Bucket[("S3: taxops11-tfstate-786567028012\n(bootstrap de TaxOps-11, reutilizado)")]
    T1["TaxOps-11\nkey: prod/terraform.tfstate"]
    T2["trip-covenas\nkey: trip-covenas/terraform.tfstate"]
    Bucket --> T1
    Bucket --> T2
```

Un solo bucket, dos proyectos, aislados por `key` — sin bootstrap nuevo, sin lock compartido (el
locking nativo de S3 vía `use_lockfile` es por objeto, no por bucket).

## CI/CD

```mermaid
flowchart TD
    PR["Pull Request\ntoca infra/, lambda/ o frontend/"] --> Plan["terraform-plan.yml\nfmt + validate + plan\n(posit al job summary)"]
    Plan --> Merge["Merge a main"]
    Merge --> Apply["terraform-apply.yml\n(push a main o manual)"]
    Apply --> Gate{"Environment: production\n¿reviewer aprueba?"}
    Gate -- No --> Blocked["Se queda esperando"]
    Gate -- Sí --> Deploy["terraform apply -auto-approve"]
    Deploy --> Live["Dashboard actualizado"]
```

Autenticación por **OIDC** (`aws-actions/configure-aws-credentials` + un IAM role de confianza
scoped a `Portfolio-jaime/trip-covenas`) — ninguna llave de AWS vive como secret de GitHub. El
proveedor OIDC en sí (`token.actions.githubusercontent.com`) es de la cuenta completa y ya existía
por `TaxOps-11`; este proyecto solo agrega su propio *role*, con su propio trust policy — no toca
el de TaxOps.

## Costo

Todo diseñado para quedar dentro de la capa siempre-gratuita de AWS al tráfico de una familia
revisando el celular unas pocas veces al día:

| Servicio | Capa gratuita | Uso real esperado |
|---|---|---|
| Lambda | 1M invocaciones/mes, siempre | Decenas/mes |
| API Gateway (HTTP API) | 1M llamadas/mes (12 meses) | Decenas/mes |
| CloudFront | 1TB salida + 10M requests/mes, siempre | KBs/mes |
| S3 | 5GB + 20k GET (12 meses) | Un `index.html` + `config.js` |
| SSM Parameter Store (Standard) | Gratis | 1 parámetro |

Sin dominio propio (evita Route53 a $0.50/mes), sin nada corriendo 24/7 (no hay servidor ni base de
datos administrada).
