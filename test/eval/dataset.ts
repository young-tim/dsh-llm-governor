/**
 * 固定 Eval 数据集：七类任务，每类 10 例，共 70 例。
 *
 * 分类来源（与 src/classifier 对应）：
 * - general：无 Hint/Rule 信号 → LLM 后端分类
 * - coding：包含 ``` 代码块 → Rule 分类（medium, 0.8）
 * - reasoning：无 Hint/Rule 信号 → LLM 后端分类
 * - writing：拼接文本 > 2000 字符 → Rule 分类（high, 0.6）
 * - data_analysis：包含 SQL 关键字 → Rule 分类（medium, 0.75）
 * - vision：hasImage=true → Hint 分类（medium, 1.0）
 * - tool_use：无 Hint/Rule 信号 → LLM 后端分类
 *
 * 复杂度分布（确保 Auto 路由在低/中复杂度选 cheaper 模型，高复杂度选 premium）：
 * - general: 2 low + 2 medium + 6 high
 * - coding: 10 medium
 * - reasoning: 2 low + 2 medium + 6 high
 * - writing: 10 high（Rule 长文规则固定返回 high）
 * - data_analysis: 10 medium
 * - vision: 10 medium（Hint 固定返回 medium）
 * - tool_use: 2 low + 2 medium + 6 high
 */
import type { TaskType, Complexity } from '../../src/index.js';

/** Eval 数据集样例。 */
export interface EvalExample {
  /** 输入文本。 */
  input: string;
  /** 预期任务类型。 */
  expectedTaskType: TaskType;
  /** 预期复杂度。 */
  expectedComplexity: Complexity;
  /** 是否包含图片输入（vision 类别使用）。 */
  hasImage?: boolean;
}

/**
 * 生成 > 2000 字符的长文输入（触发 Rule 长文规则 → writing, high）。
 * 文本不含代码块、SQL、错误栈、表格分隔符，确保只命中长文规则。
 * @param topic - 文章主题。
 * @param variation - 变体编号，用于区分不同样例。
 * @returns > 2000 字符的写作输入文本。
 */
function longWritingText(topic: string, variation: number): string {
  const paragraph = `In discussing ${topic}, it is essential to consider multiple perspectives and dimensions. The subject matter requires careful analysis of various contributing factors that shape our understanding. Historical context plays a significant role in framing current viewpoints and informing contemporary discourse. We must also examine the practical implications for future development and real-world applications across diverse domains. The interplay between theory and practice reveals important nuances that merit close attention from scholars and practitioners alike. Moreover, comparative analysis across different cultural and geographical contexts yields valuable insights that transcend conventional boundaries. Methodological considerations encompass both qualitative and quantitative approaches, each offering distinct advantages and complementary strengths. The evolving landscape demands adaptive thinking and rigorous scholarship to navigate complexity effectively.`;
  let text = `Please review and edit the following draft about ${topic} (variation ${variation}):\n\n`;
  while (text.length <= 2000) {
    text += paragraph + '\n\n';
  }
  return text;
}

/** 固定 Eval 数据集：7 类 × 10 例 = 70 例。 */
export const EVAL_DATASET: readonly EvalExample[] = [
  // ===== general（10）：2 low + 2 medium + 6 high =====
  {
    input: 'What is 2 + 2?',
    expectedTaskType: 'general',
    expectedComplexity: 'low',
  },
  {
    input: 'What is the capital of France?',
    expectedTaskType: 'general',
    expectedComplexity: 'low',
  },
  {
    input: 'Can you explain what photosynthesis is and why it matters for life on Earth?',
    expectedTaskType: 'general',
    expectedComplexity: 'medium',
  },
  {
    input:
      'What are the main differences between TCP and UDP protocols, and when would you use each?',
    expectedTaskType: 'general',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Provide a detailed analysis of the economic factors that led to the 2008 financial crisis. Discuss the role of mortgage-backed securities, the deregulation of the banking sector, the impact of subprime lending practices, and how the crisis propagated globally through interconnected financial markets. Also cover the regulatory responses that followed, including Dodd-Frank and Basel III, and evaluate their effectiveness in preventing similar crises.',
    expectedTaskType: 'general',
    expectedComplexity: 'high',
  },
  {
    input:
      'Write a comprehensive comparison of REST, GraphQL, and gRPC API design paradigms. Cover their design philosophies, typical use cases, performance characteristics, schema evolution strategies, and when to choose each for different application types. Include examples of well-known companies using each approach and discuss the trade-offs in terms of developer experience, tooling ecosystem, and operational overhead.',
    expectedTaskType: 'general',
    expectedComplexity: 'high',
  },
  {
    input:
      'Explain quantum entanglement in detail. Cover its theoretical foundations in quantum mechanics, the EPR paradox, Bells theorem and inequality, experimental verification by Aspect and others, and potential applications in quantum computing and quantum cryptography. Discuss what Einstein meant by spooky action at a distance and how subsequent experiments resolved the debate about local hidden variables.',
    expectedTaskType: 'general',
    expectedComplexity: 'high',
  },
  {
    input:
      'Provide an in-depth overview of artificial intelligence history from 1950 to 2024. Cover key milestones like the Dartmouth Conference, perceptrons, AI winters, expert systems, backpropagation, deep learning breakthroughs, and the rise of large language models. Discuss influential researchers and organizations, and the societal impact of each era including ethical considerations and regulatory responses.',
    expectedTaskType: 'general',
    expectedComplexity: 'high',
  },
  {
    input:
      'Explain how the internet works from physical infrastructure through protocols. Cover fiber optics, packet switching, TCP/IP stack, DNS resolution, BGP routing, CDN architecture, load balancers, and application protocols. Compare IPv4 and IPv6 addressing, and explain the roles of ISPs, IXPs, and major content providers in the global network topology.',
    expectedTaskType: 'general',
    expectedComplexity: 'high',
  },
  {
    input:
      'Analyze climate change science in depth. Cover the greenhouse effect mechanism, the carbon cycle, historical CO2 measurements from ice cores, IPCC assessment reports, climate models and their uncertainty ranges, feedback loops like permafrost thaw and albedo changes, tipping points, and projected temperature scenarios for different emission pathways. Discuss mitigation strategies and international agreements.',
    expectedTaskType: 'general',
    expectedComplexity: 'high',
  },

  // ===== coding（10）：10 medium（含代码块触发 Rule） =====
  {
    input:
      'Fix this bug:\n```typescript\nfunction add(a: number, b: number) {\n  return a - b;\n}\n```\nThe function should add, not subtract.',
    expectedTaskType: 'coding',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Review this code:\n```python\ndef factorial(n):\n    if n == 0:\n        return 1\n    return n * factorial(n - 1)\n```\nIs this correct?',
    expectedTaskType: 'coding',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Optimize this:\n```javascript\nconst arr = [1, 2, 3, 4, 5];\nlet sum = 0;\nfor (let i = 0; i < arr.length; i++) {\n  sum += arr[i];\n}\n```\nUse reduce instead.',
    expectedTaskType: 'coding',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Refactor this:\n```go\nfunc Sort(s []int) []int {\n  for i := 0; i < len(s); i++ {\n    for j := i + 1; j < len(s); j++ {\n      if s[i] > s[j] {\n        s[i], s[j] = s[j], s[i]\n      }\n    }\n  }\n  return s\n}\n```\nUse sort.Slice.',
    expectedTaskType: 'coding',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Explain this code:\n```rust\nfn fibonacci(n: u32) -> u32 {\n    match n {\n        0 => 0,\n        1 => 1,\n        _ => fibonacci(n - 1) + fibonacci(n - 2),\n    }\n}\n```\nHow does pattern matching work here?',
    expectedTaskType: 'coding',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Write a unit test:\n```typescript\nfunction divide(a: number, b: number): number {\n  if (b === 0) throw new Error("Division by zero");\n  return a / b;\n}\n```\nTest edge cases.',
    expectedTaskType: 'coding',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Convert this to async:\n```javascript\nfunction fetchData(url) {\n  const response = fetch(url);\n  return response.json();\n}\n```\nAdd proper error handling.',
    expectedTaskType: 'coding',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Debug this issue:\n```java\npublic List<String> filter(List<String> items) {\n  List<String> result = new ArrayList<>();\n  for (String item : items) {\n    if (item.length() > 3)\n      result.add(item);\n  }\n  return result;\n}\n```\nMissing braces causing logic error.',
    expectedTaskType: 'coding',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Improve this SQL query in code:\n```python\ncursor.execute("SELECT * FROM users")\nfor row in cursor:\n    print(row)\n```\nUse ORM instead.',
    expectedTaskType: 'coding',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Add type annotations:\n```typescript\nfunction map(arr, fn) {\n  const result = [];\n  for (let i = 0; i < arr.length; i++) {\n    result.push(fn(arr[i]));\n  }\n  return result;\n}\n```\nMake it generic.',
    expectedTaskType: 'coding',
    expectedComplexity: 'medium',
  },

  // ===== reasoning（10）：2 low + 2 medium + 6 high =====
  {
    input: 'If A > B and B > C, is A > C?',
    expectedTaskType: 'reasoning',
    expectedComplexity: 'low',
  },
  {
    input: 'All birds can fly. Penguins are birds. Can penguins fly?',
    expectedTaskType: 'reasoning',
    expectedComplexity: 'low',
  },
  {
    input:
      'In a room of 23 people, what is the probability that at least two share a birthday? Explain your reasoning step by step using the pigeonhole principle and complementary counting.',
    expectedTaskType: 'reasoning',
    expectedComplexity: 'medium',
  },
  {
    input:
      'You have 8 identical-looking balls, one heavier than the rest. Using a balance scale, what is the minimum number of weighings to identify the heavy ball? Prove your answer is optimal.',
    expectedTaskType: 'reasoning',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Three people check into a hotel room that costs 30. They each pay 10. Later, the manager realizes the room only costs 25 and sends 5 with the bellboy. The bellboy keeps 2 and gives 1 back to each person. Now each person paid 9, totaling 27, plus the 2 the bellboy kept makes 29. Where is the missing dollar? Explain the fallacy in detail and identify which premises are misleading.',
    expectedTaskType: 'reasoning',
    expectedComplexity: 'high',
  },
  {
    input:
      'A farmer needs to cross a river with a wolf, a goat, and a cabbage. The boat can carry the farmer and one item. If left alone, the wolf eats the goat, and the goat eats the cabbage. Describe all valid sequences of crossings that get everyone across safely, and prove that your solution set is complete by systematic state-space exploration.',
    expectedTaskType: 'reasoning',
    expectedComplexity: 'high',
  },
  {
    input:
      'You have 12 coins, one of which is counterfeit and has a different weight (heavier or lighter). Using a balance scale only 3 times, identify the counterfeit coin and determine whether it is heavier or lighter. Provide a complete decision tree and prove that 3 weighings are both necessary and sufficient.',
    expectedTaskType: 'reasoning',
    expectedComplexity: 'high',
  },
  {
    input:
      'Five pirates must divide 100 gold coins. The most senior pirate proposes a split. If at least half accept, it passes. Otherwise, the proposer is thrown overboard and the next most senior proposes. Pirates are perfectly logical, prefer survival, then maximize gold, then prefer throwing others overboard. What does the most senior pirate propose? Solve using backward induction and prove optimality.',
    expectedTaskType: 'reasoning',
    expectedComplexity: 'high',
  },
  {
    input:
      'There are three switches outside a room and three bulbs inside. You can enter the room only once. How do you determine which switch controls which bulb? Explain the physics principle you exploit and why this approach is information-theoretically optimal given a single observation opportunity.',
    expectedTaskType: 'reasoning',
    expectedComplexity: 'high',
  },
  {
    input:
      'A train leaves Station A traveling at 60 mph. Two hours later, another train leaves Station B 300 miles away traveling toward A at 80 mph. When and where do they meet? Then generalize: if train 1 has speed v1, train 2 has speed v2, and the delay is d hours, derive closed-form expressions for meeting time and distance from A. Verify with the original numbers.',
    expectedTaskType: 'reasoning',
    expectedComplexity: 'high',
  },

  // ===== writing（10）：10 high（长文 > 2000 字符触发 Rule） =====
  {
    input: longWritingText('the future of renewable energy', 1),
    expectedTaskType: 'writing',
    expectedComplexity: 'high',
  },
  {
    input: longWritingText('urban planning in the 21st century', 2),
    expectedTaskType: 'writing',
    expectedComplexity: 'high',
  },
  {
    input: longWritingText('the role of education in society', 3),
    expectedTaskType: 'writing',
    expectedComplexity: 'high',
  },
  {
    input: longWritingText('sustainable agriculture practices', 4),
    expectedTaskType: 'writing',
    expectedComplexity: 'high',
  },
  {
    input: longWritingText('the impact of social media on communication', 5),
    expectedTaskType: 'writing',
    expectedComplexity: 'high',
  },
  {
    input: longWritingText('space exploration and colonization', 6),
    expectedTaskType: 'writing',
    expectedComplexity: 'high',
  },
  {
    input: longWritingText('mental health in modern workplaces', 7),
    expectedTaskType: 'writing',
    expectedComplexity: 'high',
  },
  {
    input: longWritingText('the evolution of democratic institutions', 8),
    expectedTaskType: 'writing',
    expectedComplexity: 'high',
  },
  {
    input: longWritingText('biodiversity and ecosystem conservation', 9),
    expectedTaskType: 'writing',
    expectedComplexity: 'high',
  },
  {
    input: longWritingText('the philosophy of scientific progress', 10),
    expectedTaskType: 'writing',
    expectedComplexity: 'high',
  },

  // ===== data_analysis（10）：10 medium（含 SQL 关键字触发 Rule） =====
  {
    input:
      'Analyze this query and suggest improvements:\nSELECT name, age FROM users WHERE age > 18 ORDER BY name',
    expectedTaskType: 'data_analysis',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Optimize this SQL:\nSELECT u.name, COUNT(o.id) FROM users u LEFT JOIN orders o ON u.id = o.user_id GROUP BY u.name HAVING COUNT(o.id) > 5',
    expectedTaskType: 'data_analysis',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Explain the execution plan for:\nSELECT * FROM products p WHERE p.price > (SELECT AVG(price) FROM products)',
    expectedTaskType: 'data_analysis',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Rewrite this with a CTE:\nSELECT department, AVG(salary) FROM employees GROUP BY department HAVING AVG(salary) > (SELECT AVG(salary) FROM employees)',
    expectedTaskType: 'data_analysis',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Find duplicate records:\nSELECT email, COUNT(*) FROM customers GROUP BY email HAVING COUNT(*) > 1',
    expectedTaskType: 'data_analysis',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Create a summary report from:\nSELECT region, SUM(amount) as total FROM sales GROUP BY region ORDER BY total DESC',
    expectedTaskType: 'data_analysis',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Add indexes for this query:\nSELECT * FROM orders WHERE customer_id = 100 AND status = "pending" ORDER BY created_at',
    expectedTaskType: 'data_analysis',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Convert this to a window function:\nSELECT name, salary, (SELECT AVG(salary) FROM employees) as avg_salary FROM employees',
    expectedTaskType: 'data_analysis',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Analyze this schema design:\nCREATE TABLE orders (id INT, customer_id INT, total DECIMAL, created_at TIMESTAMP)',
    expectedTaskType: 'data_analysis',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Write a pivot query:\nSELECT product, SUM(CASE WHEN month = "Jan" THEN amount ELSE 0 END) as jan, SUM(CASE WHEN month = "Feb" THEN amount ELSE 0 END) as feb FROM sales GROUP BY product',
    expectedTaskType: 'data_analysis',
    expectedComplexity: 'medium',
  },

  // ===== vision（10）：10 medium（hasImage=true 触发 Hint） =====
  {
    input: 'What objects are visible in this image?',
    expectedTaskType: 'vision',
    expectedComplexity: 'medium',
    hasImage: true,
  },
  {
    input: 'Describe the scene in this photo.',
    expectedTaskType: 'vision',
    expectedComplexity: 'medium',
    hasImage: true,
  },
  {
    input: 'How many people are in this picture?',
    expectedTaskType: 'vision',
    expectedComplexity: 'medium',
    hasImage: true,
  },
  {
    input: 'What text appears in this screenshot?',
    expectedTaskType: 'vision',
    expectedComplexity: 'medium',
    hasImage: true,
  },
  {
    input: 'Identify the landmark in this photo.',
    expectedTaskType: 'vision',
    expectedComplexity: 'medium',
    hasImage: true,
  },
  {
    input: 'What colors dominate this image?',
    expectedTaskType: 'vision',
    expectedComplexity: 'medium',
    hasImage: true,
  },
  {
    input: 'Is there a cat in this photo? Describe what you see.',
    expectedTaskType: 'vision',
    expectedComplexity: 'medium',
    hasImage: true,
  },
  {
    input: 'Describe the chart shown in this image and extract the key data points.',
    expectedTaskType: 'vision',
    expectedComplexity: 'medium',
    hasImage: true,
  },
  {
    input: 'What type of document is shown in this scanned image?',
    expectedTaskType: 'vision',
    expectedComplexity: 'medium',
    hasImage: true,
  },
  {
    input: 'Compare the two images and describe the differences.',
    expectedTaskType: 'vision',
    expectedComplexity: 'medium',
    hasImage: true,
  },

  // ===== tool_use（10）：2 low + 2 medium + 6 high =====
  {
    input: 'Search the web for the latest news about artificial intelligence.',
    expectedTaskType: 'tool_use',
    expectedComplexity: 'low',
  },
  {
    input: 'Check the current weather in Shanghai.',
    expectedTaskType: 'tool_use',
    expectedComplexity: 'low',
  },
  {
    input: 'Find flights from Beijing to New York next Friday and compare prices across airlines.',
    expectedTaskType: 'tool_use',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Look up the stock price of Apple and calculate the percentage change over the past week.',
    expectedTaskType: 'tool_use',
    expectedComplexity: 'medium',
  },
  {
    input:
      'Plan a 7-day trip to Japan: search for flights, hotels, and attractions. Create an itinerary that balances Tokyo, Kyoto, and Osaka. Check weather forecasts, find local restaurants with good reviews, and estimate the total budget including transportation between cities. Book the cheapest flights and most highly-rated hotels within budget.',
    expectedTaskType: 'tool_use',
    expectedComplexity: 'high',
  },
  {
    input:
      'Research the competitive landscape for electric vehicles: search for market share data, identify the top 5 manufacturers, find their latest quarterly revenue and unit sales, compare their battery technology specs, and create a summary table. Also search for recent news about supply chain challenges and government subsidies affecting the industry.',
    expectedTaskType: 'tool_use',
    expectedComplexity: 'high',
  },
  {
    input:
      'Monitor a production system: query the database for error logs in the last hour, search the knowledge base for known issues matching the error patterns, check the status of all microservices via the health check API, send a Slack notification to the on-call engineer with a summary, and create a Jira ticket with the diagnostic findings and suggested remediation steps.',
    expectedTaskType: 'tool_use',
    expectedComplexity: 'high',
  },
  {
    input:
      'Build a competitive analysis report: scrape product pages from 3 competitor websites, extract pricing and feature lists, search for customer reviews on multiple platforms, aggregate sentiment scores, query the internal CRM for lost-deal reasons, cross-reference with industry analyst reports, and generate a comprehensive document with charts and actionable recommendations.',
    expectedTaskType: 'tool_use',
    expectedComplexity: 'high',
  },
  {
    input:
      'Automate data pipeline validation: query the data warehouse for row counts across all tables, compare against expected values from the metadata service, search the CI logs for recent pipeline failures, check S3 bucket sizes for data lag, run a data quality SQL check, notify the data team via email with a summary, and open a tracking issue if any discrepancies exceed the threshold.',
    expectedTaskType: 'tool_use',
    expectedComplexity: 'high',
  },
  {
    input:
      'Investigate a security incident: search SIEM logs for the suspicious IP address, query the firewall rules, check the asset inventory for affected hosts, search threat intelligence feeds for known indicators, query the IAM system for recent access changes, correlate findings, and generate an incident response report with timeline, affected assets, and recommended containment actions.',
    expectedTaskType: 'tool_use',
    expectedComplexity: 'high',
  },
];
