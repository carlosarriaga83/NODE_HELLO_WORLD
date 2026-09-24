# WA Control

Dashboard Node.js para vincular y gestionar multiples cuentas de WhatsApp con [Baileys](https://baileys.wiki/). Cada cuenta conserva sus credenciales en una carpeta propia y se vincula desde el panel mediante un codigo QR.

Baileys es una libreria no oficial para WhatsApp Web. Utiliza el proyecto de forma responsable y de acuerdo con los Terminos de WhatsApp. El panel esta pensado para comunicaciones autorizadas, no para envios masivos no solicitados.

## Ejecutar localmente

Requiere Node.js 20 o superior.

```bash
npm start
```

Abre `http://localhost:3000`. Para desarrollo con recarga automatica:

```bash
npm run dev
```

## Uso del panel

1. Pulsa **Nueva cuenta** y asigna un nombre interno.
2. Pulsa **Vincular** y elige **Escanear QR** o **Vincular con numero**. Para el segundo metodo, indica el numero internacional de la cuenta, abre **Dispositivos vinculados** en WhatsApp, elige vincular con numero e introduce el codigo temporal mostrado por el panel.
3. Al crearla, copia la API key mostrada: solo se muestra una vez. Puedes rotarla desde la tarjeta de la cuenta.
4. En WhatsApp, abre **Dispositivos vinculados** y escanea el QR mostrado por el panel.
5. Una vez conectada, selecciona la cuenta en **Nuevo mensaje**, indica el numero internacional con solo digitos y escribe el mensaje.

Las sesiones de Baileys se guardan en `data/sessions/` y siguen excluidas de Git; no elimines esa carpeta en el servidor si quieres conservar las conexiones vinculadas. En Hostinger, las cuentas, sus hashes de API key y los registros cifrados se conservan en MySQL. En desarrollo, si no defines variables de MySQL, la aplicacion usa `data/accounts.json` y `data/logs/` como respaldo local.

## API del dashboard

| Metodo | Ruta | Funcion |
| --- | --- | --- |
| `GET` | `/api/accounts` | Lista cuentas y estado de conexion. |
| `POST` | `/api/accounts` | Crea una cuenta con `{ "name": "Ventas" }`. |
| `GET` | `/api/accounts/:id/qr` | Obtiene el QR vigente de una cuenta. |
| `POST` | `/api/accounts/:id/pairing-code` | Genera un codigo de vinculacion con `{ "phone": "5215512345678" }`. |
| `POST` | `/api/accounts/:id/messages` | Envia `{ "to": "5215512345678", "text": "Hola" }`. |
| `DELETE` | `/api/accounts/:id` | Elimina la cuenta y sus credenciales locales. |

## API REST por cuenta

Cada cuenta tiene una API key independiente. Envia la clave mediante el encabezado `X-API-Key`; no la incluyas en una URL, repositorio ni archivo de codigo.

| Metodo | Ruta | Funcion |
| --- | --- | --- |
| `POST` | `/v1/messages` | Envia un mensaje desde la cuenta vinculada a `{ "to": "5215512345678", "text": "Hola" }`. |
| `GET` | `/v1/messages?limit=50` | Devuelve hasta 100 mensajes del registro cifrado, tras desbloquearlo. |

Ejemplo de envio desde Python:

```python
import os
import requests

response = requests.post(
	"https://wa.2api2.com/v1/messages",
	headers={"X-API-Key": os.environ["WA_API_KEY"]},
	json={"to": "5215512345678", "text": "Hola desde Python"},
	timeout=20,
)
response.raise_for_status()
print(response.json())
```

## Registro cifrado

Los mensajes entrantes y salientes se guardan por cuenta con AES-256-GCM, en MySQL cuando la aplicacion se ejecuta con la configuracion de Hostinger. El dashboard no permite verlos directamente: usa **Registro** en la tarjeta de la cuenta, solicita un codigo y recibelo en esa misma cuenta de WhatsApp. El codigo dura 10 minutos; el token de lectura generado dura 15 minutos.

Para consumir mensajes desde una integracion, primero desbloquea el registro en el dashboard y envia el token temporal junto con la API key:

```python
headers = {
	"X-API-Key": os.environ["WA_API_KEY"],
	"X-Log-Access-Token": os.environ["WA_LOG_ACCESS_TOKEN"],
}
messages = requests.get("https://wa.2api2.com/v1/messages?limit=50", headers=headers, timeout=20)
messages.raise_for_status()
print(messages.json()["messages"])
```

## Subir a GitHub

Desde la carpeta del proyecto:

```bash
git init
git add .
git commit -m "Aplicacion Node.js inicial"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPOSITORIO.git
git push -u origin main
```

Crea antes un repositorio vacio en GitHub y sustituye la URL del ejemplo por la suya.

## Desplegar en Hostinger

1. En hPanel, abre el subdominio que alojara el panel y entra en **Node.js**.
2. Conecta el repositorio de GitHub `carlosarriaga83/NODE_HELLO_WORLD`, rama `main`.
3. Selecciona Node.js 20 o superior, tipo `other`, directorio raiz vacio, archivo de inicio `server.js` y npm como gestor de paquetes.
4. Ejecuta el build. Hostinger instalara las dependencias declaradas en `package.json` y arrancara la aplicacion.
5. Protege la URL con el mecanismo de acceso restringido que uses en tu hosting antes de vincular cuentas de WhatsApp.

El servidor usa la variable de entorno `PORT` asignada por Hostinger. En local usa el puerto `3000` de forma predeterminada. Para persistencia administrada, configura `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` y `DB_PASSWORD`; Hostinger puede crearlas de forma segura al configurar la base. La aplicacion crea las tablas `wa_accounts` y `wa_message_logs` al arrancar y, si la base esta vacia, importa las cuentas y registros locales existentes una sola vez.

Para una clave de cifrado controlada por el servidor, configura `LOG_ENCRYPTION_KEY` con una cadena base64 de 32 bytes. Si no existe, el servidor reutiliza la clave local existente; en una instalacion MySQL nueva deriva una clave estable desde el secreto de base de datos para que los registros sigan siendo legibles entre despliegues. No incluyas ninguna de estas variables en Git.
