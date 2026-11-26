"""Tests for the `Cuotas` tab integration in handler.build_summary.

Run from the repo root (no third-party packages needed):

    python3 -m unittest discover -s lambda/tests -v

The handler imports `requests` and `google-auth` at module level; they are only
used for network calls, so they are stubbed here to keep the tests offline.
"""

import os
import sys
import types
import unittest

for name in ("requests", "google", "google.auth", "google.auth.transport", "google.auth.transport.requests",
             "google.oauth2", "google.oauth2.service_account"):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules["google.auth.transport.requests"].Request = object
sys.modules["google.oauth2.service_account"].Credentials = object
sys.modules["google.oauth2"].service_account = sys.modules["google.oauth2.service_account"]
sys.modules["requests"].exceptions = types.SimpleNamespace(RequestException=Exception)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import handler  # noqa: E402

COSTO = 3_600_000  # 18 person-nights -> 200,000 per person-night
CABANA = [
    ["Fecha de entrada", 46385],
    ["Fecha de salida", 46391],
    ["Costo total cabaña", COSTO],
]
PERSONAS = [
    ["Nombre", "Grupo familiar", "Noches en cabaña", "Participa gastos variables (Sí/No)", "Nota"],
    ["Ana", "Grupo Ana", 6, "Sí", ""],
    ["Beto", "Grupo Ana", 6, "Sí", ""],
    ["Carla", "Grupo Carla", 6, "Sí", ""],
    ["Total noches-persona:", "", 18],
]
ABONOS = [
    ["Fecha", "Nombre", "Grupo familiar", "Concepto", "Valor"],
    [46000, "Ana", "Ana", "Abono reserva", 1_500_000],
    [46001, "Carla", "Carla", "Abono reserva", 1_200_000],
    ["TOTAL ABONADO:", "", "", "", 2_700_000],
]
GASTOS = [["Fecha", "Quién pagó", "Categoría", "Descripción", "Valor"]]

CUOTAS_TAB = [
    ["💰 CUOTAS POR PERSONA · lo que debe cada uno"],
    ["Los abonos se hicieron por familia..."],
    [],
    ["Tarifa por persona-noche", 200_000],
    ["Falta por pagar de la cabaña", 900_000],
    [],
    ["Nombre", "Familia", "Cuota cabaña", "Cubierto", "Falta", "Estado", "Noches",
     "Abonos de la familia", "Abonó directo", "Rol", "Orden"],
    ["Ana", "Grupo Ana", 1_200_000, 1_200_000, 0, "Al día", 6, 1_500_000, 1_500_000, "Principal", 1],
    ["Beto", "Grupo Ana", 1_200_000, 300_000, 900_000, "Debe", 6, 1_500_000, 0, "Familiar", 2],
    ["Carla", "Grupo Carla", 1_200_000, 1_200_000, 0, "Al día", 6, 1_200_000, 1_200_000, "Principal", 1],
]


def summary(extra=None):
    return handler.build_summary(CABANA, PERSONAS, ABONOS, GASTOS, extra_sheets=extra)


def por_nombre(data):
    return {p["nombre"]: p for p in data["personas"]}


class ParseCuotasTest(unittest.TestCase):
    def test_reads_cubierto_falta_and_principal_by_normalized_name(self):
        parsed = handler.parse_cuotas(CUOTAS_TAB)
        self.assertEqual(set(parsed), {"ana", "beto", "carla"})
        self.assertEqual(parsed["beto"], {"cubierto": 300_000.0, "falta": 900_000.0, "principal": False})
        self.assertTrue(parsed["ana"]["principal"])

    def test_returns_empty_without_the_expected_columns(self):
        self.assertEqual(handler.parse_cuotas([["Nombre", "Familia"], ["Ana", "x"]]), {})
        self.assertEqual(handler.parse_cuotas([]), {})
        self.assertEqual(handler.parse_cuotas([["algo", "sin", "encabezado"]]), {})


class SummaryUsesTheSheetTest(unittest.TestCase):
    def test_sheet_split_overrides_the_proportional_one(self):
        data = summary({"Cuotas": CUOTAS_TAB})
        p = por_nombre(data)
        self.assertEqual(p["Beto"]["faltaCabana"], 900_000)
        self.assertEqual(p["Beto"]["aplicado"], 300_000)
        self.assertFalse(p["Beto"]["esPrincipal"])
        self.assertEqual(p["Ana"]["faltaCabana"], 0)
        self.assertTrue(p["Ana"]["esPrincipal"])
        self.assertTrue(data["totales"]["cuotasDesdeHoja"])

    def test_saldo_uses_what_was_applied_not_what_the_person_deposited(self):
        p = por_nombre(summary({"Cuotas": CUOTAS_TAB}))
        # Beto never deposited anything himself, but his family's abono covers 300,000 of his quota.
        self.assertEqual(p["Beto"]["totalAbonado"], 0)
        self.assertEqual(p["Beto"]["saldo"], 300_000 - p["Beto"]["totalACargo"])

    def test_tab_title_match_ignores_case_and_accents(self):
        self.assertTrue(summary({"CUOTAS": CUOTAS_TAB})["totales"]["cuotasDesdeHoja"])

    def test_without_the_tab_it_falls_back_to_the_proportional_split(self):
        data = summary()
        p = por_nombre(data)
        self.assertFalse(data["totales"]["cuotasDesdeHoja"])
        self.assertIsNone(p["Beto"]["aplicado"])
        self.assertIsNone(p["Beto"]["esPrincipal"])
        # group Ana owes 2,400,000 - 1,500,000 = 900,000, split by nights: 450,000 each
        self.assertEqual(p["Ana"]["faltaCabana"], 450_000)
        self.assertEqual(p["Beto"]["faltaCabana"], 450_000)

    def test_person_missing_from_the_tab_keeps_the_fallback_value(self):
        tab = [r for r in CUOTAS_TAB if not (r and r[0] == "Carla")]
        p = por_nombre(summary({"Cuotas": tab}))
        self.assertIsNone(p["Carla"]["aplicado"])
        self.assertEqual(p["Carla"]["faltaCabana"], 0)  # 1,200,000 quota fully paid by the family

    def test_cuotas_tab_is_still_exposed_as_an_extra_tab(self):
        data = summary({"Cuotas": CUOTAS_TAB})
        self.assertIn("Cuotas", data["extra"])


if __name__ == "__main__":
    unittest.main()
