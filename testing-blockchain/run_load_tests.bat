@echo off
SET JMETER=C:\Users\Acer\Downloads\apache-jmeter-5.6.3\apache-jmeter-5.6.3\bin\jmeter.bat
SET DIR=C:\Users\Acer\Downloads\TugasAkhir\testing-blockchain\jmeter_load_test_plans

echo ============================================
echo  LOAD TESTING - HYPERLEDGER FABRIC
echo  Pastikan backend ACTIVE_BLOCKCHAIN=fabric
echo ============================================
pause

echo [1/3] Fabric 10 Users...
call %JMETER% -n -t %DIR%\load_test_fabric_10u.jmx -l %DIR%\hasil_fabric_10u.csv -e -o %DIR%\report_fabric_10u
echo Done Fabric 10u

echo [2/3] Fabric 50 Users...
call %JMETER% -n -t %DIR%\load_test_fabric_50u.jmx -l %DIR%\hasil_fabric_50u.csv -e -o %DIR%\report_fabric_50u
echo Done Fabric 50u

echo [3/3] Fabric 100 Users...
call %JMETER% -n -t %DIR%\load_test_fabric_100u.jmx -l %DIR%\hasil_fabric_100u.csv -e -o %DIR%\report_fabric_100u
echo Done Fabric 100u

echo ============================================
echo  LOAD TESTING - ETHEREUM
echo  Ganti backend ke ACTIVE_BLOCKCHAIN=ethereum
echo  lalu tekan Enter
echo ============================================
pause

echo [4/6] Ethereum 10 Users...
call %JMETER% -n -t %DIR%\load_test_ethereum_10u.jmx -l %DIR%\hasil_ethereum_10u.csv -e -o %DIR%\report_ethereum_10u
echo Done ETH 10u

echo [5/6] Ethereum 50 Users...
call %JMETER% -n -t %DIR%\load_test_ethereum_50u.jmx -l %DIR%\hasil_ethereum_50u.csv -e -o %DIR%\report_ethereum_50u
echo Done ETH 50u

echo [6/6] Ethereum 100 Users...
call %JMETER% -n -t %DIR%\load_test_ethereum_100u.jmx -l %DIR%\hasil_ethereum_100u.csv -e -o %DIR%\report_ethereum_100u
echo Done ETH 100u

echo ============================================
echo  SEMUA SELESAI! Sekarang jalankan:
echo  node load_test_monitor.js --fab-10 hasil_fabric_10u.csv ...
echo ============================================
pause
