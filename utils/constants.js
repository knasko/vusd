export const USDC_ADDRESS = "0xaa5b845F8C9c047779bEDf64829601d8B264076c";
export const VUSD_ADDRESS = "0x5b91e29Ae5A71d9052620Acb813d5aC25eC7a4A2";

export const V3_POOLS = [
  { name: "V3 0.05%", address: "0xb808a593Ce19eaf73D3A69B02A5a74E57B8edc7d", fee: 500 },
  { name: "V3 0.3%",  address: "0x3a7377c1C2AEf2424aAda1BcDBEE1322170b40F0", fee: 3000 },
];

export const V3_ROUTER_ADDRESS = "0x33d2394f6Ca43aba6716982d6CB0824Db4A912b2";
export const V2_ROUTER_ADDRESS = "0x39aD8C3067281e60045DF041846EE01c1Dd3a853";

export const USDC_DECIMALS = 6;
export const VUSD_DECIMALS = 18;

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)"
];

export const V3_ROUTER_ABI = [
    "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256)",
  "function WETH9() view returns (address)"
];

export const V2_ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)"
];
