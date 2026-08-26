// El 0DTE se ve SIEMPRE en oscuro, como la versión de referencia del grupo:
// es una vista de cinta y cadena que se mira durante horas de sesión, y el
// histograma de volumen y los bordes de estado (verde/rojo) se leen mucho mejor
// sobre fondo oscuro.
//
// Va aquí, en un layout de ruta, y NO dentro de la página, por lo mismo que el
// script anti-parpadeo de app/layout.tsx: si lo fijara React en un efecto, la
// primera pintada saldría en claro y saltaría a oscuro — un flash feo cada vez
// que se entra. Este `<script>` corre mientras el HTML se está sirviendo, antes
// de pintar.
//
// El script solo cubre la carga completa de la página; para las navegaciones
// desde la barra lateral (que no vuelven a ejecutar scripts inyectados) el
// forzado vive en un efecto de page.tsx, que además restaura el tema anterior al
// salir. Ninguno de los dos ESCRIBE en localStorage: la preferencia global del
// usuario se queda como estaba, y el toggle de la app sigue funcionando aquí
// dentro si alguien quiere ver esta vista en claro.

const forceDark = `(function(){try{document.documentElement.setAttribute('data-theme','dark');}catch(e){}})();`;

export default function ZeroDteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: forceDark }} />
      {children}
    </>
  );
}
