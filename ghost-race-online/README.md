# GHOST RACE: Possession Run — online (sala única, 4 jugadores)

Tu juego conserva su diseño, carretera, vehículos, colisiones, explosiones, posesión y reglas. Lo único que cambia es **dónde se simula**:
ahora el **servidor es la autoridad** y los navegadores envían sus órdenes (cambiar de carril, frenar) y dibujan lo que reciben.

| Archivo | Qué es |
|---|---|
| `public/core.js` | La lógica del juego original (tráfico, vehículos, colisiones, daño, posesión). La ejecuta el servidor; el cliente solo lee sus constantes. |
| `public/index.html` | Cliente: mismo render y HUD que antes + pantalla de entrada, vestíbulo, red e interpolación. |
| `public/config.js` | Dirección del servidor (vacía = mismo dominio). |
| `server.js` | HTTP estático + WebSocket + sala única. **Sin dependencias** (solo Node). |
| `.env.example` | Variables de entorno. |
| `test/smoke.js` | Prueba automática con jugadores simulados (`npm test`, Node ≥ 22), incluida la autodestrucción. |
| `render.yaml` | Configuración opcional para Render (sin probar). |

## Autodestrucción (tecla E o aro de la esquina)
Abandona voluntariamente un vehículo lento: explota y el fantasma salta al vehículo libre más cercano por delante (mismo sistema de posesión que siempre).
- Recarga de **10 s** medida por el **servidor** (`SELF_DESTRUCT_COOLDOWN_S` en `.env`, o la constante `SELF_DESTRUCT_COOLDOWN_S` al inicio de `server.js`).
- El cliente solo *solicita* usarla; el servidor valida (carrera activa, vehículo en marcha, habilidad cargada) y consume la carga una sola vez. Clics repetidos o manipulados se rechazan.
- La recarga es del **jugador**, no del vehículo: no se reinicia al cambiar de vehículo y se conserva al reconectar. Cada carrera empieza con la habilidad cargada.
- El aro del cliente se dibuja con los milisegundos restantes que envía el servidor en cada instantánea (no hay un temporizador visual aparte).
- La tecla E no entra en conflicto con otros controles (← → ↓). Mantenerla pulsada no la repite.

## Reglas de la sala
- Una sola sala, 4 plazas, **código fijo** (`ROOM_CODE`) comprobado **solo en el servidor** (el cliente nunca lo contiene).
- Cada navegador guarda un identificador propio: abrir otra pestaña **no ocupa otra plaza** (la pestaña antigua se cierra).
- Inicia el anfitrión (el primero en entrar), con **2 o más** jugadores. Si el anfitrión se va, el siguiente jugador pasa a serlo.
- Quien entra con una carrera en curso espera en el vestíbulo y juega la siguiente.
- Desconexión en carrera: su plaza se guarda `RECONNECT_GRACE_S` segundos (su vehículo sigue recto). Si vuelve (mismo navegador), recupera su corredor; si no, se libera. Si solo queda un corredor, gana.
- Gana el primero que llega a la meta; se muestra la clasificación por progreso.

## Probar en local
```bash
cp .env.example .env        # y edita ROOM_CODE
node server.js              # o: npm start   (Node >= 18)
```
Abre `http://localhost:3000`. Para probar con 4 jugadores en tu red, abre `http://IP-DE-TU-PC:3000` desde otros dispositivos (permite el puerto en el firewall).
**Importante:** las pestañas del mismo navegador comparten identidad (cuenta como un solo jugador). Para varios jugadores usa navegadores/perfiles distintos, ventanas de incógnito o móviles.

## Publicar en internet
Necesitas **un servidor Node que se quede encendido** (la sala vive en memoria; usa **una sola instancia**). Vale cualquier alojamiento que ejecute Node con WebSocket (Render, Railway, Fly.io, un VPS…).
1. Sube esta carpeta, comando de arranque `node server.js`, y define las variables de `.env.example` en el panel del alojamiento (`ROOM_CODE` obligatorio).
2. El alojamiento te dará una URL `https://…`; el cliente se conectará solo por `wss://` al mismo dominio. No hay que tocar nada más.
3. Comprueba `https://TU-URL/healthz` (responde `ok`).

**Cliente y servidor en sitios distintos** (p. ej. cliente en hosting estático): sube `public/` al hosting estático, pon en `public/config.js` `window.GHOST_WS='wss://TU-SERVIDOR'` y en el servidor `ALLOWED_ORIGINS=https://TU-CLIENTE`.

## Lo que no se ha podido comprobar
Solo se ha probado en local con jugadores simulados. No se ha desplegado en internet ni probado con móviles reales o con latencia de red real.
Los cambios de carril tienen el retardo de ida y vuelta al servidor (no hay predicción en el cliente).
