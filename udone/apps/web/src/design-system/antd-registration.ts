import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Layout,
  Modal,
  Pagination,
  Popconfirm,
  Radio,
  Result,
  Row,
  Select,
  Skeleton,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'ant-design-vue';
import type { Plugin } from 'vue';

/**
 * 全局注册的 antd 组件。
 *
 * 为什么不 `app.use(Antd)`：那会注册全部 ~70 个组件，主 chunk 到 1.87 MB。
 * 这里只列**界面实际用到**的组件；Props 里没列的子组件（`AFormItem`、`ATextarea`、
 * `ARangePicker`、`ATypographyTitle` 等）由上层的 install 一并注册。
 *
 * 新增界面用到别的组件时**必须补进这个数组**：漏了不会构建失败，也不会类型报错，
 * 只会渲染成空白标签，所以有 `antd-registration.test.ts` 守着。
 */
export const antdComponents: Plugin[] = [
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Layout,
  Modal,
  Pagination,
  Popconfirm,
  Radio,
  Result,
  Row,
  Select,
  Skeleton,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
];
