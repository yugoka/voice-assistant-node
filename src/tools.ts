export const updateToolListFunction = {
  type: "function",
  name: "update_tools_list",
  description: `Updates the tool list based on user requests. When users request external API integration, physical operations, or additional information, this must be called. If the necessary tools are already in the tool list, there's no need to call it. Each time this function is called, the tool list is updated according to the current context. If there are any instructions that cannot be handled with the current tool list, this must be called.
Important: Please provide a brief response to the user before calling this tool. A message with a "please wait a moment" nuance is recommended.`,
  parameters: {
    type: "object",
    properties: {},
  },
};
