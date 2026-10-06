// Tipos del evento SSE de la vista en vivo del Playbook del Rango.
// Ver app/api/scalping/vivo/route.ts.

import type { Observacion } from "@/lib/scalping";

/** Una ficha resuelta. Llegan de una en una, según van saliendo. */
export interface ScalpingObsEvent {
  type: "obs";
  observacion: Observacion;
  /** true si esta ficha es la fila YA CONGELADA del día, no una vista en vivo. */
  congelada: boolean;
}

/** Un ticker que no se pudo mirar. La vista lo dice en su tarjeta. */
export interface ScalpingFalloEvent {
  type: "fallo";
  ticker: string;
  message: string;
}

export interface ScalpingDoneEvent {
  type: "done";
  resueltos: number;
  fallidos: number;
}

export interface ScalpingErrorEvent {
  type: "error";
  message: string;
}

export type ScalpingSseEvent =
  | ScalpingObsEvent
  | ScalpingFalloEvent
  | ScalpingDoneEvent
  | ScalpingErrorEvent;
