# Hola Mundo con Node.js

Aplicacion Node.js minima que sirve una pagina web y puede ejecutarse en Hostinger.

## Ejecutar localmente

Requiere Node.js 18 o superior.

```bash
npm start
```

Abre `http://localhost:3000`. Para desarrollo con recarga automatica:

```bash
npm run dev
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

1. En hPanel, abre **Websites** y crea o selecciona un sitio.
2. En la seccion **Node.js**, conecta el repositorio de GitHub o sube los archivos del proyecto.
3. Define el directorio raiz como la carpeta que contiene `package.json`.
4. Configura el archivo de inicio como `server.js` y el comando de arranque como `npm start`.
5. Instala las dependencias si el panel lo solicita y pulsa **Start** o **Restart**.

El servidor usa la variable de entorno `PORT` asignada por Hostinger. En local usa el puerto `3000` de forma predeterminada.
