# ZUÑIGA RUNNING 🏃

Aplicación web gratuita, en español y adaptada al celular para registrar carreras y caminatas.

## Funciones de esta primera versión
- Seguimiento de distancia y recorrido mediante GPS.
- Cronómetro con pausa y reanudación.
- Ritmo medio por kilómetro, parciales de cada kilómetro completo y estimación orientativa de calorías.\n- Tipos de actividad: carrera, caminata y senderismo.\n- Velocidad máxima estimada por actividad.\n- Exportación de la ruta GPS de cada actividad en formato GPX, además del resumen CSV.
- Resumen de progreso e historial guardado en el navegador.
- Exportación del historial a CSV.
- Interfaz instalable como acceso directo/PWA compatible con navegadores que lo admiten.

## Publicar en GitHub Pages
1. Abre **Settings** en este repositorio.
2. Entra a **Pages**.
3. En **Build and deployment**, selecciona **Deploy from a branch**.
4. Selecciona la rama **main** y la carpeta **/(root)** y pulsa **Save**.
5. Espera a que termine la publicación. La dirección normalmente será `https://lzunigapalacios-collab.github.io/ZUNIGA-RUNNING/`.

## Usar el GPS en Android
- Abre la página publicada con HTTPS en Chrome.
- Autoriza la ubicación para el navegador y activa la ubicación del teléfono.
- Sal a un lugar abierto, pulsa **Iniciar entrenamiento** y espera a que aparezca GPS conectado.
- Para la prueba más fiable, mantén la app visible y la pantalla encendida.\n- Puedes intentar bloquear la pantalla, pero Android/Chrome pueden suspender la página o el GPS; el registro en segundo plano no está garantizado en esta versión web.\n- Pausa si haces una parada y finaliza para guardar.

## Datos y limitaciones\nLas estadísticas de velocidad máxima y calorías son estimaciones basadas en puntos GPS/distancia, no mediciones de un sensor dedicado. Los parciales se guardan cuando el GPS registra cada kilómetro completo.
Las actividades se guardan localmente en el navegador de ese dispositivo. Exporta el CSV como respaldo; no existe todavía sincronización entre dispositivos, cuenta de usuario, servidor, funciones sociales ni integración con Strava. La precisión depende del teléfono y de las condiciones de señal. Las calorías son estimaciones y no una medición médica.

Este proyecto no necesita API keys ni servicios de pago para las funciones incluidas.