# Techcenter-Konventionen

Haus-Regeln, die Snipe-IT selbst nicht weiß. Vom Operator zu pflegen.

## Asset-Tag-Schema

<!-- Beispiel — vom Operator anpassen:
- Format: `AST-NNNN`, vierstellig, fortlaufend, keine Lücken.
- Snipe-IT vergibt den Tag automatisch, wenn kein manuell
  vorgedruckter Aufkleber existiert.
- Benutzer bringt einen vorgedruckten Aufkleber mit: vorhandenen
  Tag übernehmen, nicht doppelt vergeben.
-->

## Default-Werte bei neuen Assets

- **Status Label**: *Ready to Deploy*, außer Foto zeigt Defekt →
  *Broken*.
- **Location**: ohne Hinweis vom Benutzer nicht raten — fragen.
- **Company**: <!-- Techcenter-Default eintragen -->
- **Department**: <!-- optional -->

## Kategorien, die ein Foto brauchen

<!-- z. B. alles ab 100 € Warenwert, alles mit Seriennummer
     Laptops, Desktops, Werkzeuge, 3D-Drucker -->

## Ausleih-Regeln

<!-- Beispiel — bitte anpassen:
- Werkzeuge max. 14 Tage am Stück.
- Laptops dürfen nur an interne Mitarbeitende, nicht an externe
  Teilnehmende (andere Category/Process).
-->

## Ausmustern (Archivieren) vs. Löschen

- Default ist **Archivieren via Status Label**. Reversibel.
- Hartes Löschen nur auf ausdrücklichen Wunsch — und nur **ein**
  Asset pro Bestätigung.

## Photo-Policy

- Produktfoto → `asset_thumbnail` (Hauptbild).
- Rechnung, Lieferschein, Handbuch → `asset_files` (Files-Tab).
- Serial-Nummer-Nahaufnahme: bei bereits vorhandenem Produktfoto
  → `asset_files`, sonst `asset_thumbnail` und später durch besseres
  Foto ersetzen.
