# Coveñas Trip Dashboard

Gasto compartido de un viaje familiar a Coveñas (Sucre, Colombia), llevado en una hoja de cálculo
de Google que la familia edita desde el celular, con un dashboard en vivo que lee esa hoja y
muestra el balance de cada quien sin que nadie tenga que abrir Excel.

**🌊 Dashboard en vivo:** https://d3v68ejd8s9g4n.cloudfront.net/
**API (JSON):** https://rbzg7ddzyh.execute-api.us-east-1.amazonaws.com/api/summary

---

## Qué hace

- La cabaña ($6.860.000 COP, 6 noches, 12 personas base) se prorratea **por noche por persona**,
  no parejo — quien llega o se va en fecha distinta paga proporcional automáticamente.
- Cada grupo familiar (Andrés, Ana, Alex, Sandra, Casa Mery, Paty, + Julián como caso especial sin
  confirmar) ve cuánto le corresponde pagar, cuánto ha abonado, y si está al día o debe.
- Los gastos variables (comida, transporte, actividades) se registran en la misma hoja y se
  reparten entre los que participan.
- El dashboard se actualiza solo — no hay que pedirle a nadie que regenere nada, lee el Sheets en
  cada carga de página.

Ver `docs/ARQUITECTURA.md` para el cómo.

## Stack

| Capa | Tecnología |
|---|---|
| Fuente de datos | Google Sheets (API v4, lectura vía Service Account) |
| Backend | AWS Lambda (Python 3.12) + API Gateway HTTP API |
| Frontend | HTML/CSS/JS estático, sin build step |
| Hosting | S3 + CloudFront |
| IaC | Terraform, state en S3 (bucket compartido con `TaxOps-11`, key propia) |
| CI/CD | GitHub Actions, auth vía OIDC (sin llaves de AWS en GitHub) |

## Estructura del repo

```
.
├── Gastos_Covenas.xlsx      # respaldo/plantilla original — la fuente real es el Sheets, no este archivo
├── frontend/                # sitio estático (index.html + config.js con el API URL)
├── lambda/                  # handler.py — lee el Sheets, arma el JSON que consume el frontend
├── infra/                   # Terraform (S3, CloudFront, Lambda, API Gateway, IAM, OIDC)
│   └── README.md            # cómo desplegar a mano (init/plan/apply)
├── docs/
│   ├── ARQUITECTURA.md      # diagramas + decisiones de diseño
│   └── google-service-account-setup.md   # cómo crear la Service Account de Google
└── .github/workflows/       # terraform-plan.yml (PR) + terraform-apply.yml (push a main)
```

## Desarrollo / despliegue

Requiere direnv (`.envrc` ya carga el perfil de AWS y la cuenta de GitHub correctos al entrar a la
carpeta). Pasos completos en [`infra/README.md`](infra/README.md).

```bash
cd infra
terraform init
terraform plan -var "google_spreadsheet_id=<sheet id>"
```

`terraform apply` en `main` corre solo en CI, y pide tu aprobación manual antes de aplicar (ver
`docs/ARQUITECTURA.md` → CI/CD).

## Costo

Diseñado para quedar dentro de la capa siempre-gratuita de AWS (Lambda, API Gateway, CloudFront)
para el tráfico de una familia revisando el celular — real, no estimado: unos centavos al mes en el
peor caso. Sin dominio propio (evita el cargo de Route53), sin nada corriendo 24/7.

## Recursos AWS

Todos los recursos están etiquetados (`Project=covenas-dashboard`, `ManagedBy=terraform`) para
identificarlos fácil en la cuenta — ver `infra/providers.tf`.
