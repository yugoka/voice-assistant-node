export interface BaseTool {
  id: string;
  name: string;
  description: string;
  schema: string;
  auth_type: string;
  user_id: string;
  credential?: string;
  execution_count: number;
  average_execution_time: number;
  success_count: number;
  instruction_examples: string[];
  created_at: string;
}

export interface FunctionDef {
  name: string;
  type?: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
  baseTool?: BaseTool;
}

export interface ToolSearchApiResponse {
  type: string;
  function: FunctionDef;
  path: string;
  method: string;
  baseTool: BaseTool;
}
