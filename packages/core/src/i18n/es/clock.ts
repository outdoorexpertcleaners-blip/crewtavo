/**
 * The Clock (apps/web/src/features/clock and core/timeclock.ts): a tech's clock by kind of work,
 * Fix times, and the office's pay-period timesheet. GLOSSARY.md first: Clock in / Clock out are
 * "Marcar entrada" / "Marcar salida", a break is "descanso".
 */
import type { Catalog } from "../index";

export default {
  // The kinds of work (the owner's names)
  "Pressure washing": "Lavado a presión",
  "Christmas lights": "Luces de Navidad",
  "Shop / other": "Taller / otro",
  "Break (unpaid)": "Descanso (sin pago)",
  "Lights": "Luces",
  "Shop": "Taller",

  // A tech's clock (ClockPage.tsx)
  "Whose time": "De quién es el tiempo",
  "Team": "Equipo",
  "My clock": "Mi reloj",
  "The office doesn't keep your hours": "La oficina no lleva tus horas",
  "Hi {name}": "Hola, {name}",
  "Hi": "Hola",
  "Clocked out": "Salida marcada",
  "Clocked in": "Entrada marcada",
  "since {time}": "desde las {time}",
  "Pick what you're starting on": "Elige en qué vas a empezar",
  "Clock in to": "Marcar entrada en",
  "Switch to": "Cambiar a",
  "Clock out": "Marcar salida",
  "You're still clocked in from {day} at {time}. Set the time you actually stopped.": "Todavía tienes la entrada marcada desde el {day} a las {time}. Pon la hora en que de verdad terminaste.",
  "Fix {day}'s times": "Corregir las horas del {day}",
  "Fix times": "Corregir horas",
  "Nothing yet today.": "Nada todavía hoy.",
  "{time} worked": "{time} trabajadas",
  "This week · {from} – {to}": "Esta semana · {from} – {to}",
  "Total hours": "Horas en total",

  // The office's pay period (ClockPage.tsx)
  "Pay period": "Período de pago",
  "Download hours (CSV)": "Descargar horas (CSV)",
  "Previous pay period": "Período de pago anterior",
  "Next pay period": "Período de pago siguiente",
  "This period": "Este período",
  "Clock a tech in or out with the buttons, or tap a day to add or fix hours. • means times were changed by hand. Breaks are left out of the hours.":
    "Marca la entrada o salida de un técnico con los botones, o toca un día para agregar o corregir horas. • quiere decir que las horas se cambiaron a mano. Los descansos no cuentan en las horas.",
  "Nobody keeps time yet": "Nadie lleva horas todavía",
  "Add hours": "Agregar horas",
  "{what} since {time}": "{what} desde las {time}",
  "Hours this period · {hours} total": "Horas de este período · {hours} en total",
  "Fix {name}'s times on {day}": "Corregir las horas de {name} del {day}",
  "Times changed by hand": "Horas cambiadas a mano",
  "Clocked in now": "Con la entrada marcada ahora",
  "Week {number}": "Semana {number}",
  "These are hours worked, by day. Pay rates and pay aren't shown here.": "Estas son las horas trabajadas, por día. Las tarifas y el pago no se muestran aquí.",

  // Fix times (FixTimesDialog.tsx and core/timeclock.ts)
  "Times saved": "Horas guardadas",
  "Fix {name}'s times": "Corregir las horas de {name}",
  "Some of this day's time is approved. Ask the office to change it.": "Parte del tiempo de este día ya está aprobado. Pídele a la oficina que lo cambie.",
  "Nothing on this day yet.": "Nada en este día todavía.",
  "Start time": "Hora de inicio",
  "End time": "Hora de fin",
  "Remove this block": "Quitar este bloque",
  "Add a block": "Agregar un bloque",
  "Leave the end time empty only if you're still working.": "Deja la hora de fin vacía solo si todavía estás trabajando.",
  "Save times": "Guardar horas",
  "Every block needs a start time.": "Cada bloque necesita una hora de inicio.",
  "A block can't be longer than 16 hours.": "Un bloque no puede durar más de 16 horas.",
  "That start time hasn't happened yet.": "Esa hora de inicio todavía no ha llegado.",
  "Add an end time. That day is over.": "Agrega una hora de fin. Ese día ya terminó.",
  "Only the last block can be left without an end time.": "Solo el último bloque puede quedar sin hora de fin.",
  "Two blocks overlap. Change the times so they don't.": "Dos bloques se enciman. Cambia las horas para que no se encimen.",
} satisfies Catalog;
