import { z } from 'zod';

/**
 * 游客名单契约（R-TOURIST-01）。
 *
 * 三条边界写在这里，免得后来者「顺手」放宽：
 *
 * 1. **名单挂在订单上，不是客户上**。同一个客户下次再来是一条新订单，游客行不复用：
 *    名单记录的是「这一团都有谁」，与客户档案是两件事。
 * 2. **去重键是「证件类型 + 规范化证件号」，空号码不合并**。规范化在数据库里由生成列
 *    完成（去空白、去连字符、统一大写），前端与 API 都不能自己造一套算法——两套算法
 *    一旦分叉，去重就会时而生效时而失效。
 * 3. **证件是成对的**：有号码必须有类型。改号码时要求同时给出类型，否则会出现
 *    「号码换了、类型还是旧的」，而去重键正好由这两列组成。
 */

export const TOURIST_DOCUMENT_TYPES = [
  'id_card',
  'passport',
  'hk_macau_permit',
  'taiwan_permit',
] as const;
export const touristDocumentTypeSchema = z.enum(TOURIST_DOCUMENT_TYPES);
export type TouristDocumentType = z.infer<typeof touristDocumentTypeSchema>;

export const TOURIST_PERSON_TYPES = ['adult', 'child'] as const;
export const touristPersonTypeSchema = z.enum(TOURIST_PERSON_TYPES);
export type TouristPersonType = z.infer<typeof touristPersonTypeSchema>;

export const TOURIST_GENDERS = ['male', 'female', 'unknown'] as const;
export const touristGenderSchema = z.enum(TOURIST_GENDERS);
export type TouristGender = z.infer<typeof touristGenderSchema>;

/** CSV 导入的模式。覆盖会先清空名单，因此前端必须显式让用户确认。 */
export const TOURIST_IMPORT_MODES = ['append', 'replace'] as const;
export const touristImportModeSchema = z.enum(TOURIST_IMPORT_MODES);
export type TouristImportMode = z.infer<typeof touristImportModeSchema>;

/**
 * 名单里的一行。
 *
 * `documentNumber` / `phone` 只在持有 `customer.sensitive.read` 时下发；
 * 其余角色只拿到 `documentNumberMasked` / `phoneMasked`。两个字段同时出现在
 * 同一个对象里是刻意的——前端不必再判断「这个人有没有权限」，只渲染拿到的那份。
 */
export const touristSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  phoneMasked: z.string().optional(),
  phone: z.string().optional(),
  documentType: touristDocumentTypeSchema.optional(),
  documentNumberMasked: z.string().optional(),
  documentNumber: z.string().optional(),
  personType: touristPersonTypeSchema,
  /** 年龄是选填：证件的出生日期并不总能换算，用户不填就别逼他编一个。 */
  age: z.number().int().min(0).max(150).optional(),
  gender: touristGenderSchema,
  remark: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Tourist = z.infer<typeof touristSchema>;

/**
 * 名单 + 人数差。
 *
 * 差额由服务端算：`declared*` 来自订单的申报人数，`*Count` 是名单实际人数。
 * 需求明确「不一致只警告，不阻止保存」，所以它不是一个错误，而是一段要一直
 * 显示在订单详情里的信息——放在响应里，前端两个数字就不会各算一次。
 */
export const touristRosterSchema = z.object({
  items: z.array(touristSchema),
  total: z.number().int().min(0),
  adultCount: z.number().int().min(0),
  childCount: z.number().int().min(0),
  personCount: z.number().int().min(0),
  declaredAdultCount: z.number().int().min(0),
  declaredChildCount: z.number().int().min(0),
});
export type TouristRoster = z.infer<typeof touristRosterSchema>;

const touristFields = {
  name: z.string().trim().min(1).max(50),
  phone: z.string().trim().min(1).max(20).nullable().optional(),
  age: z.number().int().min(0).max(150).nullable().optional(),
  gender: touristGenderSchema.optional(),
  remark: z.string().trim().max(500).nullable().optional(),
};

export const createTouristRequestSchema = z
  .object({
    ...touristFields,
    documentType: touristDocumentTypeSchema.nullable().optional(),
    documentNumber: z.string().trim().min(1).max(40).nullable().optional(),
    personType: touristPersonTypeSchema,
  })
  .refine((value) => !value.documentNumber || Boolean(value.documentType), {
    message: 'documentType is required when documentNumber is present',
    path: ['documentType'],
  });
export type CreateTouristRequest = z.infer<typeof createTouristRequestSchema>;

/**
 * 改一行。空 PATCH 直接 400（与标签、线路同一口径）。
 *
 * 传了 `documentNumber` 就必须同时传 `documentType`：证件是「类型 + 号码」一对，
 * 只改一半会让去重键落在旧类型上，而用户以为换了证件。
 */
export const updateTouristRequestSchema = z
  .object({
    name: touristFields.name.optional(),
    phone: touristFields.phone,
    age: touristFields.age,
    gender: touristFields.gender,
    remark: touristFields.remark,
    documentType: touristDocumentTypeSchema.nullable().optional(),
    documentNumber: z.string().trim().min(1).max(40).nullable().optional(),
    personType: touristPersonTypeSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'at least one field is required',
  })
  .refine((value) => value.documentNumber === undefined || Boolean(value.documentType), {
    message: 'documentType must be sent together with documentNumber',
    path: ['documentType'],
  });
export type UpdateTouristRequest = z.infer<typeof updateTouristRequestSchema>;

export const orderTouristParamsSchema = z.object({
  orderId: z.string().min(1).max(64),
});

export const touristParamsSchema = z.object({
  orderId: z.string().min(1).max(64),
  touristId: z.string().min(1).max(64),
});

export const touristRosterResponseSchema = z.object({ roster: touristRosterSchema });
export const touristResponseSchema = z.object({ tourist: touristSchema });
export const touristDeletedResponseSchema = z.object({ deletedTouristId: z.string().min(1) });

/** 导入的解析结果。预览与提交共用同一份请求体，提交时服务端会重新解析一遍。 */
export const touristImportRequestSchema = z.object({
  /**
   * CSV 原文。前端用 FileReader 读出文本再提交，服务端重新解析 —— 这样
   * 「预览看到的」与「真正写进去的」由同一段代码决定，前端改不动结果。
   */
  csv: z.string().min(1).max(200_000),
  mode: touristImportModeSchema.default('append'),
});
export type TouristImportRequest = z.infer<typeof touristImportRequestSchema>;

export const touristImportErrorSchema = z.object({
  /** CSV 行号，从 1 开始（第 1 行是表头）。 */
  line: z.number().int().min(1),
  message: z.string(),
});
export type TouristImportError = z.infer<typeof touristImportErrorSchema>;

export const touristImportRowSchema = z.object({
  line: z.number().int().min(2),
  name: z.string(),
  phoneMasked: z.string().optional(),
  documentType: touristDocumentTypeSchema.optional(),
  documentNumberMasked: z.string().optional(),
  personType: touristPersonTypeSchema,
  age: z.number().int().optional(),
  gender: touristGenderSchema,
  remark: z.string().optional(),
});

export const touristImportPreviewResponseSchema = z.object({
  totalRows: z.number().int().min(0),
  validRows: z.number().int().min(0),
  invalidRows: z.number().int().min(0),
  rows: z.array(touristImportRowSchema),
  errors: z.array(touristImportErrorSchema),
  /** 导入后名单会变成多少人，与申报人数并排比较。 */
  summary: z.object({
    adultCount: z.number().int().min(0),
    childCount: z.number().int().min(0),
    personCount: z.number().int().min(0),
    declaredAdultCount: z.number().int().min(0),
    declaredChildCount: z.number().int().min(0),
  }),
});
export type TouristImportPreview = z.infer<typeof touristImportPreviewResponseSchema>;

export const touristImportResultSchema = z.object({
  inserted: z.number().int().min(0),
  deleted: z.number().int().min(0),
});
export type TouristImportResult = z.infer<typeof touristImportResultSchema>;

/**
 * 模板不是文件下载而是 JSON。
 *
 * Worker 没有静态目录，加一个 `text/csv` 端点就要绕过 `respond()` 的契约校验，
 * 从而让「所有出站响应都过 schema」这条规则出现例外。返回文件名 + 内容，
 * 由前端拼 Blob 触发下载，两端都还在契约里。`content` 以 UTF-8 BOM 开头：
 * 没有 BOM，Excel 打开中文表头就是乱码。
 */
export const touristTemplateResponseSchema = z.object({
  filename: z.string().min(1),
  content: z.string().min(1),
});
