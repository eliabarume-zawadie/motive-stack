import { z } from "zod";

export const AdAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  account_status: z.number(),
  currency: z.string().optional(),
  timezone_name: z.string().optional(),
  amount_spent: z.string().optional(),
});

export const CampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  effective_status: z.string(),
  objective: z.string(),
});

export const LeadFormSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
});

export const LeadSchema = z.object({
  id: z.string(),
  created_time: z.string(),
  field_data: z.array(z.object({ name: z.string(), values: z.array(z.string()) })),
});

export const CreatedSchema = z.object({ id: z.string() });

export const listOf = <T extends z.ZodTypeAny>(item: T) => z.object({ data: z.array(item) });
