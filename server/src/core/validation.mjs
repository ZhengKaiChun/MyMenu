import { z } from 'zod';
export const uuid = z.uuid();
export const name = z.string().trim().min(1).max(40);
export const note = z.string().trim().max(300).default('');
export const role = z.enum(['cook', 'eater']);
export const identity = z.enum([
  '野生小猪',
  '猪爸爸',
  '猪妈妈',
  '猪大儿',
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
    featured: z.boolean().default(false),
    meatType: z.enum(['', '猪', '鸡', '牛', '鱼', '海鲜', '其他']).default(''),
    spiceLevel: z.number().int().min(1).max(3).default(1),
    collectionId: uuid,
    coverId: uuid.nullable().optional(),
    minutes: z.number().int().min(1).max(1440),
    servings: z.number().int().min(1).max(99),
    ingredients: z.array(ingredient).max(100).default([]),
    steps: z
      .array(
        z
          .object({
            text: z.string().trim().max(3000).default(''),
            imageId: uuid.nullable().optional(),
          })
          .strict()
          .refine((s) => s.text.length > 0 || !!s.imageId, '步骤需填写文字或添加图片'),
      )
      .max(80)
      .default([]),
    version: z.number().int().positive().optional(),
  })
  .strict();
export const mealDate = z.iso.date();
export const slot = z.enum(['早餐', '午餐', '晚餐']);
export const decision = z.enum(['accept', 'reject']);
