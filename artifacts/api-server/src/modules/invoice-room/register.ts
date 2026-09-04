import { registerSweep } from "../pipeline/pipeline";
import { sweepInvoiceRoomReminders } from "./service";

registerSweep("invoice_room.reminders", () => sweepInvoiceRoomReminders());
