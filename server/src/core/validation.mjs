import { z } from 'zod';
export const uuid = z.uuid();
export const name = z.string().trim().min(1).max(40);
export const note = z.string().trim().max(300).default('');
export const role = z.enum(['cook', 'eater']);
export const identity = z.enum([
  '野生小猪',
  '猪爸爸',
  '猪妈妈',
  '猪大二',
  '猪二儿',
  '猪大妞',
  '猪二妞',
]);
export const ingredient = z
  .object({
    name: z.string().trim().min(1).max(40),
    quantity: z.number().positive().max(100000),
    unit: z.string().trim().min(1).max(12),
  })
  .strict();
export const recipe = z
  .object({
    name,
    intro: z.string().trim().max(200).default(''),
    collectionId: uuid,
    coverId: uuid.nullable().optional(),
    minutes: z.number().int().min(1).max(1440),
    servings: z.number().int().min(1).max(99),
    ingredients: z.array(ingredient).min(1).max(100),
    steps: z
      .array(
        z
          .object({ text: z.string().trim().min(1).max(3000), imageId: uuid.nullable().optional() })
          .strict(),
      )
      .min(1)
      .max(80),
    version: z.number().int().positive().optional(),
  })
  .strict();
export const mealDate = z.iso.date();
export const slot = z.enum(['早餐', '午餐', '晚餐']);
export const decision = z.enum(['accept', 'reject']);
