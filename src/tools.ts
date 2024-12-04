export const updateToolListFunction = {
  type: "function",
  name: "update_tools_list",
  description: `This tool updates the list of APIs you can use. When a user requests external integrations, external information, physical operations, etc., you must always call this instead of responding with statements like "I cannot perform physical operations." Each time this is called, the list of tools will be updated according to the latest conversation history.
Important: Before calling this tool, please respond briefly to the user. A response with nuance similar to "Please wait a moment" is recommended.`,
  parameters: {
    type: "object",
    properties: {},
  },
};
