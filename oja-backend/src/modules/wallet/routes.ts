import { Router } from "express";
import {
  createBankAccountHandler,
  createWithdrawalHandler,
  deleteBankAccountHandler,
  getWalletOverviewHandler,
  listBankAccountsHandler,
  listWithdrawalsHandler,
} from "./controller.js";

const walletRouter: Router = Router();

walletRouter.get("/", getWalletOverviewHandler);
walletRouter.get("/bank-accounts", listBankAccountsHandler);
walletRouter.post("/bank-accounts", createBankAccountHandler);
walletRouter.delete("/bank-accounts/:bankAccountId", deleteBankAccountHandler);
walletRouter.post("/withdrawals", createWithdrawalHandler);
walletRouter.get("/withdrawals", listWithdrawalsHandler);

export { walletRouter };
