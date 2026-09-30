## Qué cambia
<!-- Una o dos frases, en lenguaje de negocio. -->

## Ticket / Issue
<!-- Usa "Refs #N" (no "Closes"): el Issue se cierra cuando el cambio está verificado en producción, no al mergear. -->
Refs #
Ticket del cliente: <!-- FLX-123 / TAMA-045 / no aplica -->

## Causa raíz (si es un bug)
<!-- Archivo:línea del mecanismo, evidencia que lo prueba y qué causas alternativas se descartaron. Si es hipótesis, dilo. -->

## Alcance
- [ ] Declarado: aplica a **todos los tenants** / solo a: ______
- [ ] Sin tenants hardcodeados; permisos y queries de Supabase con scope por tenant

## Verificación
- [ ] Test de regresión que falla sin el cambio (o explico por qué no aplica)
- [ ] Type-check y tests en verde
- [ ] Si toca UI: revisada a 375px, sin scroll horizontal
- [ ] Si toca SAP: contrastado contra el dato real, no solo contra el tipo

## Después del merge
- [ ] Deploy `Production ● Ready` posterior al merge
- [ ] Comportamiento verificado en producción (evidencia: ______)
- [ ] Mensaje no técnico al cliente en el ticket (si hay ticket)
