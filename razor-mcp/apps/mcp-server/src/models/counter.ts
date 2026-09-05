/**
 * Atomic order-number counter (RZM-000123 style human-readable ids).
 * findOneAndUpdate + $inc is atomic, so concurrent checkouts never collide.
 */
import mongoose, { Schema, type Model, type InferSchemaType } from 'mongoose';

const CounterSchema = new Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { collection: 'counters' }
);

export type CounterDoc = InferSchemaType<typeof CounterSchema> & { _id: string };

export const Counter: Model<CounterDoc> =
  (mongoose.models.Counter as Model<CounterDoc>) ?? mongoose.model<CounterDoc>('Counter', CounterSchema);

export async function nextOrderNumber(): Promise<string> {
  const doc = await Counter.findOneAndUpdate(
    { _id: 'orderNumber' },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `RZM-${String(doc?.seq ?? 1).padStart(6, '0')}`;
}
